import type {
  WorkboardCard,
  WorkboardNodeGrill,
  WorkboardNodeWorktree,
} from "@openclaw/workboard-contract";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { WorkboardLifecycleSessionReader } from "./lifecycle-sync.js";
import { grillHandoffFromLog, grillSessionName, nodeGrillIsLive } from "./node-ticket-grill.js";
import { lastAssistantReply } from "./node-ticket-report.js";
import { nodeTicketTarget, type WorkboardNodeTicketRuntime } from "./node-ticket.js";
import { sanitizeSessionSegment, workboardSessionHasActiveRun } from "./session-link.js";
import { MAX_BLOCK_REASON_CHARS } from "./store-constants.js";
import { capText } from "./store-normalizers.js";
import type { WorkboardStore } from "./store.js";

// The grill session's last messages hold its last reply; earlier ones are not read.
const GRILL_HISTORY_LIMIT = 20;

function grillSessionMessage(card: WorkboardCard, handoff: string): string {
  const target = nodeTicketTarget(card);
  return [
    `Grill the operator on this Workboard ticket: ${card.title} (card \`${card.id}\`)`,
    ...(target?.hostRepoPath
      ? [
          `The repository is checked out at \`${target.hostRepoPath}\`; the ticket's own commits are on branch \`${target.worktree?.branch ?? "its ticket branch"}\` on the node, not in this checkout.`,
        ]
      : []),
    "",
    "The ticket's session researched it and handed the grilling off to this session. Its handoff:",
    "",
    handoff,
    "",
    "## How to grill",
    "- Interview the operator one question at a time until you share an understanding of what to build. Give your recommended answer with each question, and start with the handoff's first question.",
    "- Look facts up yourself (the repository, the docs, the card with `workboard_read`) instead of asking the operator for them.",
    "- Do not build anything, change files, or move the card. This session only settles what to build.",
    "- When the operator confirms the shared understanding, write the result as a handoff for the ticket session: the settled decisions, the terms you agreed on, open risks, and what the ticket session should do next. Call `workboard_grill_done` with it as `handoff`; the ticket session then resumes with it.",
  ].join("\n");
}

/** A grilling whose grill session is still to be created: the card waits in review on it. */
export function nodeGrillSessionToOpen(
  card: WorkboardCard,
): (WorkboardNodeWorktree & { grill: WorkboardNodeGrill }) | undefined {
  const worktree = nodeTicketTarget(card)?.worktree;
  const grill = worktree?.grill;
  return worktree &&
    grill &&
    !grill.sessionKey &&
    card.status === "review" &&
    nodeGrillIsLive(card, worktree)
    ? { ...worktree, grill }
    : undefined;
}

/**
 * Creates the grill session: a normal session of the card's agent on the
 * Gateway, with its agent's own model, that starts on the handoff. The key
 * names the card and the grilling, so a retried create adopts the session.
 */
async function startNodeGrillSession(
  runtime: WorkboardNodeTicketRuntime,
  card: WorkboardCard,
  round: number,
  handoff: string,
): Promise<string> {
  const name = `grill-${sanitizeSessionSegment(card.id.slice(0, 8), "card")}-${round}`;
  const key = card.agentId
    ? `agent:${sanitizeSessionSegment(card.agentId, "agent")}:${name}`
    : name;
  const result = await runtime.request(
    "sessions.create",
    {
      key,
      ...(card.agentId ? { agentId: card.agentId } : {}),
      displayName: grillSessionName(card),
      message: grillSessionMessage(card, handoff),
    },
    { scopes: ["operator.admin"] },
  );
  const record = isRecord(result) ? result : {};
  if (record.runStarted === false) {
    throw new Error(typeof record.runError === "string" ? record.runError : "no run was started");
  }
  return typeof record.key === "string" && record.key ? record.key : key;
}

/**
 * Opens the grill session of a grilling that waits for one and records it on
 * the card, which then names it. A session that cannot start blocks the card;
 * a move to todo brings it back to review, where the next pass tries again.
 */
export async function openNodeGrillSession(params: {
  store: WorkboardStore;
  runtime: WorkboardNodeTicketRuntime;
  card: WorkboardCard;
  worktree: WorkboardNodeWorktree & { grill: WorkboardNodeGrill };
}): Promise<void> {
  const { store, card, worktree } = params;
  const round = worktree.grill.rounds;
  let sessionKey: string;
  try {
    const log = await store.readNodeGrillLog(worktree);
    const handoff = log === undefined ? undefined : grillHandoffFromLog(log, round);
    if (!handoff) {
      throw new Error("its handoff could not be read from grilling.md");
    }
    sessionKey = await startNodeGrillSession(params.runtime, card, round, handoff);
  } catch (error) {
    await store.block(
      card.id,
      {
        reason: capText(
          `The grill session could not start: ${formatErrorMessage(error)}\nFix the cause, then move the card to todo to try again.`,
          MAX_BLOCK_REASON_CHARS,
        ),
      },
      null,
    );
    return;
  }
  await store.setNodeGrillSession(card.id, { worktreePath: worktree.path, round, sessionKey });
}

/**
 * The grilling result when the operator ends it: the grill session's last
 * reply. `replying` while that session runs a turn, so the end waits for it;
 * "" when the grilling has no session yet.
 */
export async function readNodeGrillResult(
  runtime: WorkboardNodeTicketRuntime,
  readSessions: WorkboardLifecycleSessionReader | undefined,
  sessionKey: string | undefined,
): Promise<{ replying: true } | { replying: false; result: string }> {
  if (!sessionKey) {
    return { replying: false, result: "" };
  }
  if (readSessions && (await workboardSessionHasActiveRun(readSessions, sessionKey))) {
    return { replying: true };
  }
  const history = await runtime.request(
    "chat.history",
    { sessionKey, limit: GRILL_HISTORY_LIMIT },
    { scopes: ["operator.read"] },
  );
  const messages = isRecord(history) && Array.isArray(history.messages) ? history.messages : [];
  return { replying: false, result: lastAssistantReply(messages) };
}
