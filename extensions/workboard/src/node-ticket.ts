import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type {
  WorkboardCard,
  WorkboardClassRung,
  WorkboardComment,
  WorkboardExecutionTarget,
  WorkboardNodeFeedback,
  WorkboardNodeHandoff,
  WorkboardNodeQuestions,
  WorkboardNodeRework,
  WorkboardNodeWorktree,
} from "@openclaw/workboard-contract";
import { isFutureDateTimestampMs } from "openclaw/plugin-sdk/number-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import {
  runPluginCommandWithTimeout,
  type PluginCommandRunResult,
} from "openclaw/plugin-sdk/run-command";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  type NodeTicketStopReport,
  parseNodeTicketReport,
  REPORT_FENCE,
} from "./node-ticket-report.js";
import {
  type WorkboardNodeTicketRouteSlot,
  workboardRouteName,
  workboardRoutePinnedNode,
  MAX_BLOCK_REASON_CHARS,
  MAX_COMMENT_BODY_CHARS,
  MAX_PROOF_NOTE_CHARS,
  workboardTaskClass,
} from "./store-constants.js";
import type { WorkboardAgentActor } from "./store-inputs.js";
import { capText } from "./store-normalizers.js";
import type { WorkboardStore } from "./store.js";

// Node output that reaches host git as a revision argument.
const COMMIT_ID = /^[0-9a-f]{40,64}$/;

/** Gateway methods a node ticket needs; both run with the dispatcher's admin authority. */
export type WorkboardNodeTicketRuntime = Pick<PluginRuntime["gateway"], "request">;

type NodeTicketTarget = WorkboardExecutionTarget & { kind: "node-claude" };

const NODE_COMMAND_TIMEOUT_MS = 120_000;
const HOST_GIT_TIMEOUT_MS = 120_000;
// Comments are capped at 2000 chars on write, so this bounds the brief's feedback section.
const REWORK_FEEDBACK_MAX_ENTRIES = 5;

export function nodeTicketTarget(card: WorkboardCard): NodeTicketTarget | undefined {
  const target = card.metadata?.automation?.target;
  return target?.kind === "node-claude" ? target : undefined;
}

/**
 * A published ticket moved back to todo (D56), or a ticket waiting with
 * questions moved to todo. It starts its next rework round, or resumes with
 * the answer, once a card comment newer than the publish or the questions
 * (and Workboard's own notices since) says what should change.
 */
export type NodeTicketReopen = {
  kind: "rework" | "answer";
  worktreePath: string;
  round: number;
  reviewed: boolean;
};

/** The proof entry label of a rung b round's standards review. */
export const STANDARDS_REVIEW_LABEL = "standards review";
// One in this many agent-accepted PRs is read by a person when the class sets no sampleEvery.
const DEFAULT_SAMPLE_EVERY = 3;

// Agents write comments in Markdown, so the label and the value may be
// emphasized: `**Verdict:** accept`, `__Verdict: rework__: why`,
// `Verdict: **accept**`. `_` is a word character, so `\b` cannot end the value.
const REVIEW_VERDICT_PATTERN =
  /^(\*{1,2}|_{1,2})?Verdict\1?:\1?\s*(?:\*{1,2}|_{1,2})?(accept|rework)(?![a-z0-9])/i;

/** An agent's shadow verdict on a review round (`Verdict: accept|rework`), if the comment is one. */
export function reviewVerdictOf(comment: WorkboardComment): "accept" | "rework" | undefined {
  const match = comment.source?.startsWith("agent:")
    ? REVIEW_VERDICT_PATTERN.exec(comment.body.trim())?.[2]?.toLowerCase()
    : undefined;
  return match === "accept" || match === "rework" ? match : undefined;
}

type ImportedHandoff = Extract<WorkboardNodeHandoff, { phase: "imported" }>;

/**
 * Who accepts an imported node ticket on its move to done. The operator does
 * unless an agent moves it; an agent may only for a class at rung b on the
 * board whose round also ran at rung b, after posting its verdict. An accept
 * verdict then picks whether a person reads the PR: every reworked ticket,
 * and 1 in `sampleEvery` others, chosen by the card id so the sample is not
 * the reader's choice. Throws the refusal an agent gets.
 */
export function nodeTicketAcceptance(params: {
  card: WorkboardCard;
  worktree: WorkboardNodeWorktree;
  handoff: ImportedHandoff;
  actor?: WorkboardAgentActor;
  classRung?: WorkboardClassRung;
}): ImportedHandoff {
  const { card, worktree, actor, classRung } = params;
  const { decidedBy: _decidedBy, sampled: _sampled, ...imported } = params.handoff;
  if (!actor) {
    return imported;
  }
  const askForVerdict = "Post `Verdict: accept` or `Verdict: rework: <finding>` as a comment";
  if (classRung?.rung !== "b") {
    throw new Error(
      `Rung a: the operator accepts ${workboardTaskClass(card.labels) ?? "unclassified"} tickets. ${askForVerdict} instead of moving the card to done.`,
    );
  }
  if (worktree.rung !== "b") {
    throw new Error(
      `This round ran before its class reached rung b, so the operator accepts it. ${askForVerdict} instead of moving the card to done.`,
    );
  }
  const verdict = (card.metadata?.comments ?? [])
    .filter((comment) => comment.createdAt >= imported.importedAt)
    .flatMap((comment) => reviewVerdictOf(comment) ?? [])
    .at(-1);
  if (!verdict) {
    throw new Error(`${askForVerdict} first, then move the card to done.`);
  }
  if (verdict === "rework") {
    return { ...imported, decidedBy: actor };
  }
  const sampleEvery = classRung.sampleEvery ?? DEFAULT_SAMPLE_EVERY;
  const sampled =
    (worktree.rework?.round ?? 0) > 0 ||
    createHash("sha256").update(card.id).digest().readUInt32BE(0) % sampleEvery === 0;
  return { ...imported, decidedBy: actor, sampled };
}

/**
 * The review feedback for a published ticket's next rework round, or the
 * answers to a ticket's questions: card comments newer than the publish or
 * the questions and Workboard's own notices since. The slot wait notice is
 * written after a review comment and is not feedback either, nor is a late
 * shadow verdict.
 */
export function nodeTicketReviewComments(card: WorkboardCard): WorkboardComment[] {
  const handoff = nodeTicketTarget(card)?.worktree?.handoff;
  if (handoff?.phase !== "published" && handoff?.phase !== "questions") {
    return [];
  }
  const from =
    handoff.reviewFrom ?? (handoff.phase === "published" ? handoff.publishedAt : handoff.askedAt);
  return (card.metadata?.comments ?? []).filter(
    (comment) =>
      comment.createdAt > from &&
      comment.createdAt !== handoff.slotWaitNotedAt &&
      !reviewVerdictOf(comment),
  );
}

export function nodeTicketReopen(card: WorkboardCard, now: number): NodeTicketReopen | undefined {
  const worktree = nodeTicketTarget(card)?.worktree;
  const handoff = worktree?.handoff;
  const claim = card.metadata?.claim;
  if (
    !worktree ||
    (handoff?.phase !== "published" && handoff?.phase !== "questions") ||
    // Starting a card with finished parents promotes it to ready first.
    (card.status !== "todo" && card.status !== "ready") ||
    card.metadata?.archivedAt ||
    (claim && isFutureDateTimestampMs(claim.expiresAt, { nowMs: now }))
  ) {
    return undefined;
  }
  return {
    kind: handoff.phase === "published" ? "rework" : "answer",
    worktreePath: worktree.path,
    round:
      handoff.phase === "published"
        ? (worktree.rework?.round ?? 0) + 1
        : (worktree.questions?.rounds ?? 0) + 1,
    reviewed: nodeTicketReviewComments(card).length > 0,
  };
}

/** Queues a start on a full slot; the card when the request was recorded. */
export async function queueNodeTicketStart(
  store: WorkboardStore,
  cardId: string,
  route: WorkboardNodeTicketRouteSlot | undefined,
  now: number,
): Promise<WorkboardCard | undefined> {
  const request = await store.requestNodeTicketStart(cardId, {
    notice: (card) => nodeTicketSlotWaitNotice(card, route, now),
  });
  return request.queued ? request.card : undefined;
}

/**
 * What a queued node ticket's notice says it waits for. `route` names a
 * capped route whose slots are full; without it the whole pool is.
 */
export function nodeTicketSlotWaitNotice(
  card: WorkboardCard,
  route: WorkboardNodeTicketRouteSlot | undefined,
  now: number,
): string {
  const reopen = nodeTicketReopen(card, now);
  const what = !reopen
    ? "This ticket"
    : reopen.kind === "rework"
      ? `Rework round ${reopen.round}`
      : "The answer";
  if (!route) {
    return `${what} waits for a node-ticket slot; it starts when a running node ticket reaches review.`;
  }
  const name = workboardRouteName(route);
  const pinned = workboardRoutePinnedNode(route);
  return pinned
    ? `${what} waits for a slot on node ${pinned}, where its worktree is, on the ${name} route; it starts when a running ticket of that route on ${pinned} reaches review.`
    : `${what} waits for a slot on the ${name} route; it starts when a running ticket on that route reaches review.`;
}

export function nodeInvokePayload(result: unknown): Record<string, unknown> {
  const envelope = isRecord(result) ? result : {};
  const payload =
    envelope.payload !== undefined
      ? envelope.payload
      : typeof envelope.payloadJSON === "string"
        ? (JSON.parse(envelope.payloadJSON) as unknown)
        : undefined;
  if (!isRecord(payload)) {
    throw new Error("node returned an invalid node.invoke result");
  }
  return payload;
}

/** Thrown when the card changed while handoff work was in flight; the newer state wins. */
export class HandoffSupersededError extends Error {
  constructor() {
    super("the card changed during the node ticket handoff");
  }
}

export async function hostGit(
  repoPath: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<PluginCommandRunResult> {
  return await runPluginCommandWithTimeout({
    argv: ["git", "-C", repoPath, ...args],
    timeoutMs: HOST_GIT_TIMEOUT_MS,
    ...(env ? { env } : {}),
  });
}

export async function requireHostGit(
  repoPath: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  const result = await hostGit(repoPath, args, env);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim() || `exit ${result.code}`;
    throw new Error(`host \`git ${args.join(" ")}\` failed: ${detail}`);
  }
  return result.stdout.trim();
}

/** Runs one argv on the node through `system.run` and returns its trimmed stdout. */
export async function runNodeCommand(
  runtime: WorkboardNodeTicketRuntime,
  nodeId: string,
  argv: string[],
): Promise<string> {
  const payload = nodeInvokePayload(
    await runtime.request(
      "node.invoke",
      {
        nodeId,
        command: "system.run",
        timeoutMs: NODE_COMMAND_TIMEOUT_MS,
        params: { command: argv, timeoutMs: NODE_COMMAND_TIMEOUT_MS },
        idempotencyKey: randomUUID(),
      },
      { scopes: ["operator.admin"] },
    ),
  );
  if (payload.success !== true) {
    const detail = [payload.stderr, payload.error, payload.stdout].find(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    );
    throw new Error(
      `node ${nodeId} failed \`${argv.join(" ")}\`: ${detail?.trim() ?? "no output"}`,
    );
  }
  return typeof payload.stdout === "string" ? payload.stdout.trim() : "";
}

/**
 * Counts an answered question round when the ticket resumes from its
 * questions; an operator's comment among the answers makes it a human touch.
 */
function answeredQuestions(
  card: WorkboardCard,
  previous: WorkboardNodeWorktree | undefined,
): WorkboardNodeQuestions | undefined {
  if (previous?.handoff?.phase !== "questions") {
    return previous?.questions;
  }
  const byOperator = nodeTicketReviewComments(card).some(
    (comment) => comment.source === "operator",
  );
  return {
    rounds: (previous.questions?.rounds ?? 0) + 1,
    operatorAnswers: (previous.questions?.operatorAnswers ?? 0) + (byOperator ? 1 : 0),
  };
}

/**
 * Creates the card's worktree in the node's own clone; the branch name is what
 * D40 bundles back. A published ticket reopened for review rework (D54)
 * restarts at the draft PR branch tip on origin, so commits a reviewer pushed
 * are kept, and keeps the original base so the next import carries them too.
 * A ticket resuming with answers to its questions reuses its worktree as is.
 */
export async function createNodeTicketWorktree(params: {
  runtime: WorkboardNodeTicketRuntime;
  card: WorkboardCard;
  target: NodeTicketTarget;
}): Promise<WorkboardNodeWorktree> {
  const { runtime, card, target } = params;
  const branch = `factory/${card.id}`;
  const worktreePath = path.posix.join(target.worktreesRoot, `wb-${card.id}`);
  const previous = target.worktree;
  if (previous?.handoff?.phase === "imported") {
    throw new Error(
      "this ticket's branch was imported but has no draft PR yet; move the card to done to publish it, then reopen it for rework",
    );
  }
  const published = previous?.handoff?.phase === "published" ? previous.handoff : undefined;
  const questions = answeredQuestions(card, previous);
  const asked = previous?.handoff?.phase === "questions" ? previous.handoff : undefined;
  // A retry of the same round carries the previous record's cutoff.
  const feedback: WorkboardNodeFeedback | undefined = published
    ? { kind: "rework", from: published.reviewFrom ?? published.publishedAt }
    : asked
      ? { kind: "answer", from: asked.reviewFrom ?? asked.askedAt }
      : previous?.feedback;
  const kept = {
    ...(questions ? { questions } : {}),
    ...(feedback ? { feedback } : {}),
    ...(previous?.reviews ? { reviews: previous.reviews } : {}),
  };
  const git = (...args: string[]) =>
    runNodeCommand(runtime, target.nodeId, ["git", "-C", target.repoPath, ...args]);
  let rework: WorkboardNodeRework | undefined;
  try {
    // The node clone only moves here; without the fetch every ticket after the
    // first merged PR would start from a stale base. Pruning drops the refs of
    // merged or closed PR branches, so rework never restarts from a stale one.
    await git("fetch", "--quiet", "--prune", "origin");
    let start: string;
    if (published && previous) {
      start = await git(
        "rev-parse",
        "--verify",
        "--quiet",
        `refs/remotes/origin/${branch}^{commit}`,
      ).catch(() => {
        throw new Error(
          `${branch} is no longer on origin, so its draft PR was merged or closed; create a new card for further changes`,
        );
      });
      if (!COMMIT_ID.test(start)) {
        throw new Error(`node ${target.nodeId} reported an invalid tip for ${branch}`);
      }
      const outside = Number(await git("rev-list", "--count", `${published.headCommit}..${start}`));
      if (!Number.isInteger(outside)) {
        throw new Error(`node ${target.nodeId} reported an invalid commit count for ${branch}`);
      }
      rework = {
        round: (previous.rework?.round ?? 0) + 1,
        pullRequestUrl: published.pullRequestUrl,
        acceptedAt: previous.rework?.acceptedAt ?? published.publishedAt,
        outsideCommits: (previous.rework?.outsideCommits ?? 0) + outside,
        startCommit: start,
      };
    } else {
      const baseRef = target.baseRef ?? "origin/HEAD";
      start = await git("rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`).catch(() => {
        throw new Error(
          `node ${target.nodeId} cannot resolve base ${baseRef} in ${target.repoPath}; ` +
            (target.baseRef
              ? "fix the target baseRef"
              : "run `git remote set-head origin --auto` there or set the target baseRef"),
        );
      });
    }
    // A commit start point creates the branch without upstream tracking.
    await git("worktree", "add", "-b", branch, worktreePath, start);
  } catch (error) {
    // A retried card finds the worktree its failed launch already created.
    const existingBranch = await runNodeCommand(runtime, target.nodeId, [
      "git",
      "-C",
      worktreePath,
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ]).catch(() => undefined);
    if (existingBranch !== branch) {
      throw error;
    }
    // A re-run after earlier commits must bundle from the original base, not the branch tip.
    if (previous?.path === worktreePath) {
      const keptRework = rework ?? previous.rework;
      return {
        path: worktreePath,
        branch,
        baseCommit: previous.baseCommit,
        ...(keptRework ? { rework: keptRework } : {}),
        ...kept,
      };
    }
  }
  if (previous && rework) {
    return { path: worktreePath, branch, baseCommit: previous.baseCommit, rework, ...kept };
  }
  const baseCommit = await runNodeCommand(runtime, target.nodeId, [
    "git",
    "-C",
    worktreePath,
    "rev-parse",
    "HEAD",
  ]);
  if (!COMMIT_ID.test(baseCommit)) {
    throw new Error(`node ${target.nodeId} reported an invalid base commit for ${worktreePath}`);
  }
  return { path: worktreePath, branch, baseCommit, ...kept };
}

/** Starts a fresh Claude Code session on the node, in the worktree, under the card's session key. */
export async function startNodeTicketSession(params: {
  runtime: WorkboardNodeTicketRuntime;
  card: WorkboardCard;
  target: NodeTicketTarget;
  worktree: WorkboardNodeWorktree;
  sessionKey: string;
  message: string;
}): Promise<{
  sessionKey: string;
  runId: string;
  runtime?: { harness: string; provider: string; model: string };
}> {
  const { card, target } = params;
  const result = await params.runtime.request(
    "sessions.create",
    {
      key: params.sessionKey,
      ...(card.agentId ? { agentId: card.agentId } : {}),
      execNode: target.nodeId,
      cwd: params.worktree.path,
      ...(target.model ? { model: target.model } : {}),
      // Session labels are unique per agent; the card id keeps same-titled cards apart.
      label: `Workboard ${card.id.slice(0, 8)}: ${card.title}`.slice(0, 120),
      message: params.message,
    },
    { scopes: ["operator.admin"] },
  );
  const record = isRecord(result) ? result : {};
  if (record.runStarted === false || typeof record.runId !== "string" || !record.runId) {
    const reason = typeof record.runError === "string" ? record.runError : "no run was started";
    throw new Error(`node ticket session did not start: ${reason}`);
  }
  const resolved = isRecord(record.resolved) ? record.resolved : {};
  return {
    sessionKey: typeof record.key === "string" && record.key ? record.key : params.sessionKey,
    runId: record.runId,
    ...(typeof resolved.modelProvider === "string" && typeof resolved.model === "string"
      ? {
          runtime: {
            harness: resolved.modelProvider,
            provider: resolved.modelProvider,
            model: resolved.model,
          },
        }
      : {}),
  };
}

export function buildNodeTicketMessage(params: {
  card: WorkboardCard;
  worktree: WorkboardNodeWorktree;
  context: string;
}): string {
  const round = params.worktree.feedback;
  const answering = round?.kind === "answer";
  const rework = answering ? undefined : params.worktree.rework;
  // The card still carries its published or questions record when the round
  // starts. A retried launch lost that record, so it reads the comments after
  // the carried cutoff, leaving out Workboard's own notices (no source).
  const handoffPhase = nodeTicketTarget(params.card)?.worktree?.handoff?.phase;
  const comments =
    handoffPhase === "published" || handoffPhase === "questions"
      ? nodeTicketReviewComments(params.card)
      : round
        ? (params.card.metadata?.comments ?? []).filter(
            (comment) => comment.createdAt > round.from && comment.source !== undefined,
          )
        : [];
  const feedback = rework || answering ? comments.slice(-REWORK_FEEDBACK_MAX_ENTRIES) : [];
  const reviewed = params.worktree.rung === "b";
  return [
    `Work on this ticket: ${params.card.title}`,
    "",
    ...(answering
      ? [
          "## Answers to your questions",
          `You stopped with open questions. Continue the ticket in the same worktree with the answers ${feedback.length > 0 ? "below" : "in the recent comments below"}.`,
          "",
          ...(feedback.length > 0
            ? [feedback.map((comment) => comment.body.trim()).join("\n\n---\n\n"), ""]
            : []),
        ]
      : []),
    ...(rework
      ? [
          `## Review rework, round ${rework.round}`,
          `This ticket already has a draft PR: ${rework.pullRequestUrl}. The worktree starts at the PR branch tip, including commits a reviewer pushed. Address the review feedback ${feedback.length > 0 ? "below" : "in the recent comments below"} with new commits on top; never rewrite or drop existing commits.`,
          "",
          ...(feedback.length > 0
            ? [
                "### Review feedback",
                "The Recent comments list further down shortens long comments; this is the full text.",
                "",
                feedback.map((comment) => comment.body.trim()).join("\n\n---\n\n"),
                "",
              ]
            : []),
        ]
      : []),
    "## Turn contract",
    `- Your working directory is the ticket worktree ${params.worktree.path} on branch ${params.worktree.branch}. Stay inside it.`,
    "- Commit your work on this branch. Never push, add remotes, or change other branches.",
    "- Do not end the turn while a background job is still running; wait for it or stop it.",
    "- If something needs a decision you cannot make from the ticket and the repository, stop and ask; propose a default.",
    ...(reviewed
      ? [
          "- Before a `done` report, run a reviewer subagent over your changes against the repository's CODING_STANDARDS.md, address its findings, and report them in `review`: how many findings it raised, how many you fixed, and a note on any you left. A `done` report without `review` blocks the card.",
        ]
      : []),
    "- End your final message with exactly one report block:",
    "",
    "```" + REPORT_FENCE,
    `{"outcome":"done|blocked|needs_input","headline":"1-3 plain sentences for the operator","summary":"what changed and why","proof":[{"command":"…","status":"passed|failed|skipped","note":"…"}],${reviewed ? '"review":{"findings":0,"fixed":0,"note":"…"},' : ""}"questions":["…"]}`,
    "```",
    "",
    "Its text fields are Markdown. The `headline` of a `done` report replaces the card's summary on the board: say what changed and why in plain words. Use `done` only when the work is committed and its proof passed. Use `needs_input` for open questions, each with your proposed default; the answers come back as the next turn of this session. Use `blocked` for anything else that stops you.",
    "Proof entries describe the final state. Any `failed` entry blocks a `done` report, so a test you ran red before the fix goes in the note of its passing entry, not in an entry of its own.",
    "",
    params.context,
  ].join("\n");
}

function blockReason(report: NodeTicketStopReport): string {
  const lead = report.outcome === "needs_input" ? "Needs input" : "Blocked";
  return [
    `${lead}: ${report.summary || "no summary given"}`,
    ...report.questions.map((question) => `- ${question}`),
  ].join("\n");
}

/**
 * Maps a finished node ticket turn onto its card. A done report records its
 * proof and marks the worktree's handoff pending, so only the bundle import
 * moves the card to review, and its headline replaces the card summary. A
 * needs_input report posts the questions and waits in review for an answer;
 * the agent_end nudge wakes the board's automation so `dev` can answer. Every
 * other ending blocks the card so `dev` sees the reason. Proof that did not pass also blocks, and so does a rung b
 * round's done report without its standards review.
 */
export async function applyNodeTicketReport(params: {
  store: WorkboardStore;
  card: WorkboardCard;
  messages: readonly unknown[];
  success: boolean;
}): Promise<void> {
  const { store, card } = params;
  const claim = card.metadata?.claim;
  const scope = claim ? { ownerId: claim.ownerId, token: claim.token } : undefined;
  const block = async (reason: string) =>
    await store.block(card.id, { reason: capText(reason, MAX_BLOCK_REASON_CHARS) }, scope);
  const parsed = parseNodeTicketReport(params.messages);
  const worktree = nodeTicketTarget(card)?.worktree;
  if (!parsed.ok) {
    // The operator's stop aborted the turn; a report that arrived before it applies below.
    if (worktree?.stopRequestedAt !== undefined) {
      await store.nodeTicketStop(card.id, { action: "settle", aborted: true });
      return;
    }
    await block(params.success ? parsed.reason : `The ticket session failed. ${parsed.reason}`);
    return;
  }
  const { report } = parsed;
  if (report.outcome === "needs_input" && worktree) {
    await store.addComment(
      card.id,
      {
        body: capText(
          `${blockReason(report)}\n\nAnswer in a comment, then move the card to todo; the same session resumes with the answer.`,
          MAX_COMMENT_BODY_CHARS,
        ),
      },
      scope,
    );
    await store.setNodeHandoff(
      card.id,
      { worktreePath: worktree.path, handoff: { phase: "questions", askedAt: Date.now() } },
      scope,
    );
    await store.releaseClaim(card.id, { ...scope, status: "review" });
    return;
  }
  if (report.outcome !== "done") {
    await block(blockReason(report));
    return;
  }
  for (const proof of report.proof) {
    await store.addProof(card.id, { ...proof, label: "ticket proof" }, scope);
  }
  // The counts are recorded, not judged: fewer fixed than found is for the reviewer of the PR.
  if (report.review) {
    const { findings, fixed, note } = report.review;
    await store.addProof(
      card.id,
      {
        status: "passed",
        label: STANDARDS_REVIEW_LABEL,
        note: capText(
          `${findings} findings, ${fixed} fixed${note ? `. ${note}` : ""}`,
          MAX_PROOF_NOTE_CHARS,
        ),
      },
      scope,
    );
  }
  if (
    !report.proof.some((proof) => proof.status === "passed") ||
    report.proof.some((proof) => proof.status === "failed")
  ) {
    await block(`Reported done without passing proof: ${report.summary || "no summary given"}`);
    return;
  }
  if (worktree?.rung === "b" && !report.review) {
    await block(
      `Reported done without the standards review its rung b brief asked for: ${report.summary || "no summary given"}\nRe-run the card; the next run reuses the node worktree, and its brief asks for the reviewer against CODING_STANDARDS.md and a \`review\` in the report.`,
    );
    return;
  }
  if (report.summary) {
    await store.addComment(card.id, { body: report.summary }, scope);
  }
  if (!worktree) {
    await block("Reported done, but the card has no recorded node worktree to import.");
    return;
  }
  await store.setNodeHandoff(
    card.id,
    {
      worktreePath: worktree.path,
      handoff: { phase: "pending", reportedAt: Date.now() },
      ...(report.headline ? { summary: report.headline } : {}),
    },
    scope,
  );
}

export const NODE_TICKET_SETTLED_WITHOUT_REPORT =
  "The ticket session settled without a workboard-report block and nothing resumed it. The run was aborted or failed, or its report never reached the board. Check the node, then comment what to do next and move the card to todo to restart; the next run reuses the worktree.";

/**
 * What a sweep that found the session idle does with a running node ticket.
 * `block`: an earlier observation already closed this round's attempt, the
 * session has not moved since, and no report, pending import, or operator
 * stop owns the card. `observe`: the session moved since that record, so the
 * wait restarts from this sweep. Judged on the card as recorded before the
 * observation, so a report's agent_end has a full sweep to land.
 */
export function nodeTicketIdleVerdict(
  card: WorkboardCard,
  sessionUpdatedAt: number | undefined,
): "block" | "observe" | undefined {
  const worktree = nodeTicketTarget(card)?.worktree;
  const claim = card.metadata?.claim;
  const execution = card.execution;
  if (
    !worktree ||
    !claim ||
    card.status !== "running" ||
    execution?.status !== "idle" ||
    sessionUpdatedAt === undefined ||
    worktree.stopRequestedAt !== undefined ||
    // A re-run claims the card seconds before its launch replaces the previous round's idle record.
    claim.claimedAt > execution.updatedAt
  ) {
    return undefined;
  }
  if (nodeTicketReportOwnsRound(worktree, claim.claimedAt)) {
    return undefined;
  }
  return sessionUpdatedAt > execution.updatedAt ? "observe" : "block";
}

/**
 * A done report owns the card through its import; a re-run after a failed
 * import carries that stale pending record from before its claim.
 */
export function nodeTicketReportOwnsRound(
  worktree: WorkboardNodeWorktree,
  claimedAt: number,
): boolean {
  const handoff = worktree.handoff;
  return handoff !== undefined && !(handoff.phase === "pending" && claimedAt > handoff.reportedAt);
}
