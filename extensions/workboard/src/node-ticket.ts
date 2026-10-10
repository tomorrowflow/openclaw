import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  WorkboardCard,
  WorkboardComment,
  WorkboardExecutionTarget,
  WorkboardNodeFeedback,
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
  MAX_BLOCK_REASON_CHARS,
  MAX_COMMENT_BODY_CHARS,
  MAX_PROOF_COMMAND_CHARS,
  MAX_PROOF_NOTE_CHARS,
} from "./store-constants.js";
import { capText } from "./store-normalizers.js";
import type { WorkboardStore } from "./store.js";

/** Gateway methods a node ticket needs; both run with the dispatcher's admin authority. */
export type WorkboardNodeTicketRuntime = Pick<PluginRuntime["gateway"], "request">;

type NodeTicketTarget = WorkboardExecutionTarget & { kind: "node-claude" };

const NODE_COMMAND_TIMEOUT_MS = 120_000;
const HOST_GIT_TIMEOUT_MS = 120_000;
const REPORT_FENCE = "workboard-report";
// Comments are capped at 2000 chars on write, so this bounds the brief's feedback section.
const REWORK_FEEDBACK_MAX_ENTRIES = 5;
const REPORT_PATTERN = new RegExp("```" + REPORT_FENCE + "\\s*\\n([\\s\\S]*?)\\n```", "g");

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
  slotWaitNoted: boolean;
};

/**
 * The review feedback for a published ticket's next rework round, or the
 * answers to a ticket's questions: card comments newer than the publish or
 * the questions and Workboard's own notices since. The slot wait notice is
 * written after a review comment and is not feedback either.
 */
export function nodeTicketReviewComments(card: WorkboardCard): WorkboardComment[] {
  const handoff = nodeTicketTarget(card)?.worktree?.handoff;
  if (handoff?.phase !== "published" && handoff?.phase !== "questions") {
    return [];
  }
  const from =
    handoff.reviewFrom ?? (handoff.phase === "published" ? handoff.publishedAt : handoff.askedAt);
  return (card.metadata?.comments ?? []).filter(
    (comment) => comment.createdAt > from && comment.createdAt !== handoff.slotWaitNotedAt,
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
    slotWaitNoted: handoff.slotWaitNotedAt !== undefined,
  };
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
  const kept = { ...(questions ? { questions } : {}), ...(feedback ? { feedback } : {}) };
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
      const outside = Number(await git("rev-list", "--count", `${published.headCommit}..${start}`));
      if (!Number.isInteger(outside)) {
        throw new Error(`node ${target.nodeId} reported an invalid commit count for ${branch}`);
      }
      rework = {
        round: (previous.rework?.round ?? 0) + 1,
        pullRequestUrl: published.pullRequestUrl,
        acceptedAt: previous.rework?.acceptedAt ?? published.publishedAt,
        outsideCommits: (previous.rework?.outsideCommits ?? 0) + outside,
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
  if (!/^[0-9a-f]{40,64}$/.test(baseCommit)) {
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
    "- End your final message with exactly one report block:",
    "",
    "```" + REPORT_FENCE,
    '{"outcome":"done|blocked|needs_input","summary":"what changed and why","proof":[{"command":"…","status":"passed|failed|skipped","note":"…"}],"questions":["…"]}',
    "```",
    "",
    "Use `done` only when the work is committed and its proof passed. Use `needs_input` for open questions, each with your proposed default; the answers come back as the next turn of this session. Use `blocked` for anything else that stops you.",
    "Proof entries describe the final state. Any `failed` entry blocks a `done` report, so a test you ran red before the fix goes in the note of its passing entry, not in an entry of its own.",
    "",
    params.context,
  ].join("\n");
}

const REPORT_PROOF_STATUSES = ["passed", "failed", "skipped"] as const;

type NodeTicketProof = {
  command?: string;
  status: (typeof REPORT_PROOF_STATUSES)[number];
  note?: string;
};

type NodeTicketStopReport = {
  outcome: "blocked" | "needs_input";
  summary: string;
  questions: string[];
};

type NodeTicketReport =
  | { outcome: "done"; summary: string; proof: NodeTicketProof[] }
  | NodeTicketStopReport;

function lastAssistantText(messages: readonly unknown[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== "assistant") {
      continue;
    }
    if (typeof message.content === "string") {
      return message.content;
    }
    if (Array.isArray(message.content)) {
      return message.content
        .flatMap((part) => (isRecord(part) && typeof part.text === "string" ? [part.text] : []))
        .join("\n");
    }
  }
  return undefined;
}

// Report fields are session output; bound them to the store limits they land in.
function optionalText(value: unknown, max: number): string | undefined {
  return typeof value === "string" ? capText(value.trim(), max) : undefined;
}

/** Reads the last report block of the final assistant message; anything else is a contract miss. */
function parseNodeTicketReport(
  messages: readonly unknown[],
): { ok: true; report: NodeTicketReport } | { ok: false; reason: string } {
  const text = lastAssistantText(messages);
  const block = text ? [...text.matchAll(REPORT_PATTERN)].at(-1)?.[1] : undefined;
  if (!block) {
    return { ok: false, reason: "The ticket session ended without a workboard-report block." };
  }
  let value: unknown;
  try {
    value = JSON.parse(block);
  } catch {
    return { ok: false, reason: "The ticket session's workboard-report block is not valid JSON." };
  }
  if (!isRecord(value)) {
    return { ok: false, reason: "The ticket session's workboard-report block is not an object." };
  }
  const summary = optionalText(value.summary, MAX_COMMENT_BODY_CHARS) ?? "";
  if (value.outcome === "done") {
    const proof = (Array.isArray(value.proof) ? value.proof : []).flatMap(
      (entry): NodeTicketProof[] => {
        const status = isRecord(entry)
          ? REPORT_PROOF_STATUSES.find((candidate) => candidate === entry.status)
          : undefined;
        if (!isRecord(entry) || !status) {
          return [];
        }
        const command = optionalText(entry.command, MAX_PROOF_COMMAND_CHARS);
        const note = optionalText(entry.note, MAX_PROOF_NOTE_CHARS);
        return [{ status, ...(command ? { command } : {}), ...(note ? { note } : {}) }];
      },
    );
    return { ok: true, report: { outcome: "done", summary, proof } };
  }
  if (value.outcome === "blocked" || value.outcome === "needs_input") {
    const questions = (Array.isArray(value.questions) ? value.questions : []).flatMap((entry) => {
      const question = optionalText(entry, MAX_BLOCK_REASON_CHARS);
      return question ? [question] : [];
    });
    return { ok: true, report: { outcome: value.outcome, summary, questions } };
  }
  return { ok: false, reason: "The ticket session's workboard-report has an unknown outcome." };
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
 * moves the card to review. A needs_input report posts the questions and
 * waits in review for an answer; the agent_end nudge wakes the board's
 * automation so `dev` can answer. Every other ending blocks the card so `dev`
 * sees the reason. Proof that did not pass also blocks.
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
  if (!parsed.ok) {
    await block(params.success ? parsed.reason : `The ticket session failed. ${parsed.reason}`);
    return;
  }
  const { report } = parsed;
  const worktree = nodeTicketTarget(card)?.worktree;
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
  if (
    !report.proof.some((proof) => proof.status === "passed") ||
    report.proof.some((proof) => proof.status === "failed")
  ) {
    await block(`Reported done without passing proof: ${report.summary || "no summary given"}`);
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
    { worktreePath: worktree.path, handoff: { phase: "pending", reportedAt: Date.now() } },
    scope,
  );
}
