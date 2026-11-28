import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import {
  workboardAgentDecides,
  type WorkboardCard,
  type WorkboardComment,
  type WorkboardExecutionTarget,
  type WorkboardNodeFeedback,
  type WorkboardNodeQuestions,
  type WorkboardNodeReusedWorktree,
  type WorkboardNodeRework,
  type WorkboardNodeWorktree,
} from "@openclaw/workboard-contract";
import { isFutureDateTimestampMs } from "openclaw/plugin-sdk/number-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import {
  runPluginCommandWithTimeout,
  type PluginCommandRunResult,
} from "openclaw/plugin-sdk/run-command";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveNodeBaseCommit } from "./node-ticket-base.js";
import {
  cutReportText,
  type NodeTicketStopReport,
  parseNodeTicketReport,
  reportComments,
} from "./node-ticket-report.js";
import { isBlockReason, reviewVerdictOf } from "./review-readiness.js";
import {
  MAX_BLOCK_REASON_CHARS,
  MAX_COMMENT_BODY_CHARS,
  MAX_PROOF_NOTE_CHARS,
} from "./store-constants.js";
import type { WorkboardStore } from "./store.js";

// Node output that reaches host git as a revision argument.
export const COMMIT_ID = /^[0-9a-f]{40,64}$/;

/** The ref a fresh ticket branches from on the node, and the main its rounds are measured against. */
export function nodeTicketBaseRef(target: { baseRef?: string }): string {
  return target.baseRef ?? "origin/HEAD";
}

/** Gateway methods a node ticket needs; both run with the dispatcher's admin authority. */
export type WorkboardNodeTicketRuntime = Pick<PluginRuntime["gateway"], "request">;

type NodeTicketTarget = WorkboardExecutionTarget & { kind: "node-claude" };

const NODE_COMMAND_TIMEOUT_MS = 120_000;
const HOST_GIT_TIMEOUT_MS = 120_000;

export function nodeTicketTarget(card: WorkboardCard): NodeTicketTarget | undefined {
  const target = card.metadata?.automation?.target;
  return target?.kind === "node-claude" ? target : undefined;
}

/**
 * A published ticket moved back to todo (D56), or a ticket waiting with
 * questions moved to todo. It starts its next rework round, or resumes with
 * the answer, once a card comment newer than the publish or the questions
 * (and Workboard's own notices since) says what should change. A grilling
 * ticket resumes once its grilling ended.
 */
export type NodeTicketReopen = {
  kind: "rework" | "answer" | "grill";
  worktreePath: string;
  round: number;
  reviewed: boolean;
};

/** The proof entry label of a rung b round's standards review. */
export const STANDARDS_REVIEW_LABEL = "standards review";

const VERIFICATION_LINE = /^\*\*Verification:\*\* (pass|fail|error)\b/;

/** Whether a card is in a 1-in-`every` sample, chosen by its id so the sample is nobody's choice. */
export function cardInSample(cardId: string, every: number): boolean {
  return createHash("sha256").update(cardId).digest().readUInt32BE(0) % every === 0;
}

/** The verifier's comment on a round starts with the verdict line `**Verification:** ...`. */
export function isVerificationComment(comment: WorkboardComment): boolean {
  return comment.source?.startsWith("agent:") === true && VERIFICATION_LINE.test(comment.body);
}

/**
 * The review feedback for a published ticket's next rework round, or the
 * answers to a ticket's questions: card comments newer than the publish or
 * the questions and Workboard's own notices since. The slot wait notice is
 * written after a review comment and is not feedback either, nor is a late
 * shadow verdict or a block reason (written with its failed notification).
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
      !isBlockReason(card, comment) &&
      !reviewVerdictOf(comment),
  );
}

export function nodeTicketReopen(card: WorkboardCard, now: number): NodeTicketReopen | undefined {
  const worktree = nodeTicketTarget(card)?.worktree;
  const handoff = worktree?.handoff;
  const claim = card.metadata?.claim;
  if (
    !worktree ||
    (handoff?.phase !== "published" &&
      handoff?.phase !== "questions" &&
      handoff?.phase !== "grilling") ||
    // Starting a card with finished parents promotes it to ready first.
    (card.status !== "todo" && card.status !== "ready") ||
    card.metadata?.archivedAt ||
    (claim && isFutureDateTimestampMs(claim.expiresAt, { nowMs: now }))
  ) {
    return undefined;
  }
  if (handoff.phase === "grilling") {
    return {
      kind: "grill",
      worktreePath: worktree.path,
      round: worktree.grill?.rounds ?? 1,
      reviewed: worktree.grill?.pending !== undefined,
    };
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

/** What a reopened round resumes with, as its notices name it. */
export function nodeTicketReopenSubject(reopen: NodeTicketReopen): string {
  if (reopen.kind === "rework") {
    return `Rework round ${reopen.round}`;
  }
  return reopen.kind === "grill" ? "The grilling result" : "The answer";
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
  options: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<string> {
  const { cwd, env, timeoutMs = NODE_COMMAND_TIMEOUT_MS } = options;
  const payload = nodeInvokePayload(
    await runtime.request(
      "node.invoke",
      {
        nodeId,
        command: "system.run",
        timeoutMs,
        params: { command: argv, timeoutMs, ...(cwd ? { cwd } : {}), ...(env ? { env } : {}) },
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

// The retry brief lists at most this many uncommitted paths.
const MAX_REUSED_DIRTY_PATHS = 50;

/**
 * What a retried launch finds in the worktree an earlier launch left. Best
 * effort: when the node cannot say, the retry starts without the note.
 */
async function inspectReusedWorktree(
  git: (...args: string[]) => Promise<string>,
  baseCommit: string,
): Promise<WorkboardNodeReusedWorktree | undefined> {
  try {
    const headCommit = await git("rev-parse", "HEAD");
    const commitsSinceBase = Number(await git("rev-list", "--count", `${baseCommit}..HEAD`));
    if (!COMMIT_ID.test(headCommit) || !Number.isInteger(commitsSinceBase)) {
      return undefined;
    }
    // The node trims stdout, so the first line may have lost its leading status column.
    const dirty = (await git("status", "--porcelain"))
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => line.replace(/^[ MADRCTU?!]{1,2} /, ""));
    return {
      headCommit,
      commitsSinceBase,
      dirtyPaths: dirty.slice(0, MAX_REUSED_DIRTY_PATHS),
      dirtyCount: dirty.length,
    };
  } catch {
    return undefined;
  }
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
      "this ticket's latest round was imported but isn't published yet; move the card to done to accept it, or to todo to rework it, and the handoff publishes the draft PR first",
    );
  }
  const published = previous?.handoff?.phase === "published" ? previous.handoff : undefined;
  const questions = answeredQuestions(card, previous);
  const asked = previous?.handoff?.phase === "questions" ? previous.handoff : undefined;
  const grilled = previous?.handoff?.phase === "grilling" ? previous.handoff : undefined;
  // A retry of the same round carries the previous record's cutoff.
  const feedback: WorkboardNodeFeedback | undefined = published
    ? { kind: "rework", from: published.reviewFrom ?? published.publishedAt }
    : asked
      ? { kind: "answer", from: asked.reviewFrom ?? asked.askedAt }
      : grilled
        ? { kind: "grill", from: grilled.askedAt }
        : previous?.feedback;
  const kept = {
    ...(questions ? { questions } : {}),
    ...(feedback ? { feedback } : {}),
    ...(previous?.grill ? { grill: previous.grill } : {}),
    ...(previous?.reviews ? { reviews: previous.reviews } : {}),
    ...(previous?.rounds ? { rounds: previous.rounds } : {}),
    // The previous round's verifiers may still run on the node; the handoff
    // pass settles it from this record once its session ends.
    ...(previous?.verification?.phase === "running" ? { verification: previous.verification } : {}),
    ...(previous?.crossVerification?.phase === "running"
      ? { crossVerification: previous.crossVerification }
      : {}),
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
      const round = (previous.rework?.round ?? 0) + 1;
      // A round the PR state sync opened for a base conflict corrects nothing,
      // even when re-running the proof commits new evidence. The import sees only
      // commits and the publish replaces the handoff that marks the round, so it
      // is recorded at the start. Feedback an operator adds before the start
      // rides along uncounted.
      const unchangedRounds = [
        ...(previous.rework?.unchangedRounds ?? []),
        ...(published.conflictReworkAt !== undefined ? [round] : []),
      ];
      rework = {
        round,
        pullRequestUrl: published.pullRequestUrl,
        acceptedAt: previous.rework?.acceptedAt ?? published.publishedAt,
        outsideCommits: (previous.rework?.outsideCommits ?? 0) + outside,
        startCommit: start,
        ...(unchangedRounds.length > 0 ? { unchangedRounds } : {}),
      };
    } else {
      const baseRef = nodeTicketBaseRef(target);
      const resolved = await resolveNodeBaseCommit({
        git,
        baseRef,
        isCommitId: COMMIT_ID.test(baseRef),
      });
      if (resolved === undefined) {
        throw new Error(
          `node ${target.nodeId} cannot resolve base ${baseRef} in ${target.repoPath}; ` +
            (target.baseRef
              ? "fix the target baseRef"
              : "run `git remote set-head origin --auto` there or set the target baseRef"),
        );
      }
      start = resolved;
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
      // Answers and a grilling result resume the worktree by design; anything
      // else here retries a launch that ended early, and its brief says so.
      const reusedFrom =
        asked || grilled
          ? undefined
          : await inspectReusedWorktree(
              (...args) =>
                runNodeCommand(runtime, target.nodeId, ["git", "-C", worktreePath, ...args]),
              previous.baseCommit,
            );
      return {
        path: worktreePath,
        branch,
        baseCommit: previous.baseCommit,
        ...(keptRework ? { rework: keptRework } : {}),
        ...kept,
        ...(reusedFrom ? { reusedFrom } : {}),
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

/** Why a `sessions.create` reply started no run; its `runError` is a Gateway error shape. */
export function sessionCreateRunError(record: Record<string, unknown>): string {
  const error = record.runError;
  return isRecord(error) && typeof error.message === "string" && error.message
    ? error.message
    : "no run was started";
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
      // Pin the runtime explicitly: model-only routing quietly falls back to the
      // embedded runtime when claude-cli is unavailable, and that runtime cannot
      // edit the node worktree. An explicit pin fails the start with the reason.
      ...(target.model ? { model: target.model, agentRuntime: "claude-cli" } : {}),
      // Session labels are unique per agent; the card id keeps same-titled cards apart.
      label: `Workboard ${card.id.slice(0, 8)}: ${card.title}`.slice(0, 120),
      message: params.message,
    },
    { scopes: ["operator.admin"] },
  );
  const record = isRecord(result) ? result : {};
  if (record.runStarted === false || typeof record.runId !== "string" || !record.runId) {
    throw new Error(`node ticket session did not start: ${sessionCreateRunError(record)}`);
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

function blockReason(report: NodeTicketStopReport): string {
  return [
    `Blocked: ${report.summary || "no summary given"}`,
    ...report.questions.map((question) => `- ${question}`),
  ].join("\n");
}

/**
 * Maps a finished node ticket turn onto its card. A done report records its
 * proof and marks the worktree's handoff pending, so only the bundle import
 * moves the card to review, and its headline replaces the card summary. A
 * needs_input report posts the questions and waits in review for an answer;
 * the agent_end nudge wakes the board's automation so `dev` can answer. A
 * grill report logs its handoff and waits in review while the node handoff
 * owner opens its grill session; any other report closes an open grill with
 * the outcome the card gets, so a refused done closes it blocked, and clears
 * the pending end of a grill that ended.
 * Every other ending blocks the card so `dev` sees the reason. Proof that
 * did not pass also blocks, and so does a rung b round's done report without
 * its standards review.
 */
export async function applyNodeTicketReport(params: {
  store: WorkboardStore;
  card: WorkboardCard;
  messages: readonly unknown[];
  success: boolean;
  error?: string;
}): Promise<void> {
  const { store, card } = params;
  const claim = card.metadata?.claim;
  const scope = claim ? { ownerId: claim.ownerId, token: claim.token } : undefined;
  // The block comment leads; the rest of a long reason follows it as comments.
  const block = async (reason: string) => {
    const [lead, ...rest] = reportComments(reason, {
      max: Math.min(MAX_BLOCK_REASON_CHARS, MAX_COMMENT_BODY_CHARS),
    });
    await store.block(card.id, { reason: lead }, scope);
    for (const body of rest) {
      await store.addComment(card.id, { body }, scope);
    }
  };
  const parsed = parseNodeTicketReport(params.messages);
  const worktree = nodeTicketTarget(card)?.worktree;
  if (!parsed.ok) {
    // The operator's stop aborted the turn; a report that arrived before it applies below.
    if (worktree?.stopRequestedAt !== undefined) {
      await store.nodeTicketStop(card.id, { action: "settle", aborted: true });
      return;
    }
    // The failed run's own error says more than the missing report; the
    // lifecycle write after this blocks the card with it, or queues it again
    // after a usage limit.
    if (!params.success && params.error) {
      return;
    }
    await block(params.success ? parsed.reason : `The ticket session failed. ${parsed.reason}`);
    return;
  }
  const { report } = parsed;
  const closeGrill = async (outcome: string, summary: string) => {
    if (worktree?.grill?.status === "open" || worktree?.grill?.pending) {
      await store.closeNodeGrill(card.id, { worktreePath: worktree.path, outcome, summary }, scope);
    }
  };
  const blockReport = async (reason: string) => {
    await closeGrill("blocked", reason);
    await block(reason);
  };
  const review = report.outcome === "done" ? report.review : undefined;
  if (worktree && (report.decisions.length > 0 || review)) {
    await store.recordNodeRound(
      card.id,
      { worktreePath: worktree.path, decisions: report.decisions, ...(review ? { review } : {}) },
      scope,
    );
  }
  if (report.outcome === "grill") {
    if (!worktree) {
      await block("Handed off a grilling, but the card has no recorded node worktree.");
      return;
    }
    const handed = await store.recordNodeGrillHandoff(
      card.id,
      { worktreePath: worktree.path, handoff: report.handoff },
      scope,
    );
    if (!handed) {
      await block(
        "Handed off a grilling, but the card's node worktree changed before it could be recorded, so no grill session started. Read the handoff in the ticket session, then comment what to do and move the card to todo to restart; the next run reuses the worktree.",
      );
      return;
    }
    await store.releaseClaim(card.id, { ...scope, status: "review" });
    return;
  }
  if (report.outcome === "needs_input" && worktree) {
    await closeGrill(report.outcome, report.summary);
    const round = reportComments(
      [
        `**Needs input:** ${report.summary || "no summary given"}`,
        "",
        ...report.questions.map((question) => `- ${question}`),
      ].join("\n"),
      {
        footer:
          "Answer in a comment, then move the card to todo; the same session resumes with the answer.",
      },
    );
    for (const body of round) {
      await store.addComment(card.id, { body }, scope);
    }
    await store.setNodeHandoff(
      card.id,
      { worktreePath: worktree.path, handoff: { phase: "questions", askedAt: Date.now() } },
      scope,
    );
    await store.releaseClaim(card.id, { ...scope, status: "review" });
    return;
  }
  if (report.outcome !== "done") {
    await blockReport(blockReason(report));
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
        note: cutReportText(
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
    await blockReport(
      `Reported done without passing proof: ${report.summary || "no summary given"}`,
    );
    return;
  }
  if (workboardAgentDecides(worktree?.rung) && !report.review) {
    await blockReport(
      `Reported done without the standards review its rung ${worktree?.rung} brief asked for: ${report.summary || "no summary given"}\nRe-run the card; the next run reuses the node worktree, and its brief asks for the reviewer against CODING_STANDARDS.md and a \`review\` in the report.`,
    );
    return;
  }
  await closeGrill("done", report.headline ?? report.summary);
  for (const body of reportComments(report.summary)) {
    await store.addComment(card.id, { body }, scope);
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
