import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  WorkboardCard,
  WorkboardExecutionTarget,
  WorkboardNodeWorktree,
} from "@openclaw/workboard-contract";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { WorkboardStore } from "./store.js";

/** Gateway methods a node ticket needs; both run with the dispatcher's admin authority. */
export type WorkboardNodeTicketRuntime = Pick<PluginRuntime["gateway"], "request">;

type NodeTicketTarget = WorkboardExecutionTarget & { kind: "node-claude" };

const NODE_COMMAND_TIMEOUT_MS = 120_000;
const REPORT_FENCE = "workboard-report";
const REPORT_PATTERN = new RegExp("```" + REPORT_FENCE + "\\s*\\n([\\s\\S]*?)\\n```", "g");

export function nodeTicketTarget(card: WorkboardCard): NodeTicketTarget | undefined {
  const target = card.metadata?.automation?.target;
  return target?.kind === "node-claude" ? target : undefined;
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

/** Creates the card's worktree in the node's own clone; the branch name is what D40 bundles back. */
export async function createNodeTicketWorktree(params: {
  runtime: WorkboardNodeTicketRuntime;
  card: WorkboardCard;
  target: NodeTicketTarget;
}): Promise<WorkboardNodeWorktree> {
  const { runtime, card, target } = params;
  const branch = `factory/${card.id}`;
  const worktreePath = path.posix.join(target.worktreesRoot, `wb-${card.id}`);
  try {
    await runNodeCommand(runtime, target.nodeId, [
      "git",
      "-C",
      target.repoPath,
      "worktree",
      "add",
      "-b",
      branch,
      worktreePath,
      target.baseRef ?? "HEAD",
    ]);
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
    if (target.worktree?.path === worktreePath) {
      return { path: worktreePath, branch, baseCommit: target.worktree.baseCommit };
    }
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
  return { path: worktreePath, branch, baseCommit };
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
  return [
    `Work on this ticket: ${params.card.title}`,
    "",
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
    "Use `done` only when the work is committed and its proof passed. Use `needs_input` for open questions and `blocked` for anything else that stops you.",
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

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
  const summary = optionalText(value.summary) ?? "";
  if (value.outcome === "done") {
    const proof = (Array.isArray(value.proof) ? value.proof : []).flatMap(
      (entry): NodeTicketProof[] => {
        const status = isRecord(entry)
          ? REPORT_PROOF_STATUSES.find((candidate) => candidate === entry.status)
          : undefined;
        if (!isRecord(entry) || !status) {
          return [];
        }
        const command = optionalText(entry.command);
        const note = optionalText(entry.note);
        return [{ status, ...(command ? { command } : {}), ...(note ? { note } : {}) }];
      },
    );
    return { ok: true, report: { outcome: "done", summary, proof } };
  }
  if (value.outcome === "blocked" || value.outcome === "needs_input") {
    const questions = (Array.isArray(value.questions) ? value.questions : []).flatMap((entry) => {
      const question = optionalText(entry);
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
 * moves the card to review; every other ending blocks the card so `dev` sees
 * the reason. Proof that did not pass also blocks.
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
  const parsed = parseNodeTicketReport(params.messages);
  if (!parsed.ok) {
    const reason = params.success ? parsed.reason : `The ticket session failed. ${parsed.reason}`;
    await store.block(card.id, { reason }, scope);
    return;
  }
  const { report } = parsed;
  if (report.outcome !== "done") {
    await store.block(card.id, { reason: blockReason(report) }, scope);
    return;
  }
  for (const proof of report.proof) {
    await store.addProof(card.id, { ...proof, label: "ticket proof" }, scope);
  }
  if (
    !report.proof.some((proof) => proof.status === "passed") ||
    report.proof.some((proof) => proof.status === "failed")
  ) {
    await store.block(
      card.id,
      {
        reason: `Reported done without passing proof: ${report.summary || "no summary given"}`,
      },
      scope,
    );
    return;
  }
  if (report.summary) {
    await store.addComment(card.id, { body: report.summary }, scope);
  }
  const worktree = nodeTicketTarget(card)?.worktree;
  if (!worktree) {
    await store.block(
      card.id,
      { reason: "Reported done, but the card has no recorded node worktree to import." },
      scope,
    );
    return;
  }
  await store.setNodeHandoff(
    card.id,
    { worktreePath: worktree.path, handoff: { phase: "pending", reportedAt: Date.now() } },
    scope,
  );
}
