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
import {
  nodeTicketTarget,
  sessionCreateRunError,
  type WorkboardNodeTicketRuntime,
} from "./node-ticket.js";
import {
  sanitizeSessionSegment,
  sessionProvesPreparedAcceptance,
  workboardSessionHasActiveRun,
} from "./session-link.js";
import { MAX_BLOCK_REASON_CHARS } from "./store-constants.js";
import { capText } from "./store-normalizers.js";
import type { WorkboardStore } from "./store.js";

const GRILL_SESSION_GROUP = "Grilling";

// The grill session's last messages hold its last reply; earlier ones are not read.
const GRILL_HISTORY_LIMIT = 20;

function grillSessionMessage(card: WorkboardCard, handoff: string | undefined): string {
  const target = nodeTicketTarget(card);
  return [
    `Grill the operator on this Workboard ticket: ${card.title} (card \`${card.id}\`)`,
    ...(target?.hostRepoPath
      ? [
          `The repository is checked out at \`${target.hostRepoPath}\`; the ticket's own commits are on branch \`${target.worktree?.branch ?? "its ticket branch"}\` on the node, not in this checkout.`,
        ]
      : []),
    "",
    ...(handoff
      ? [
          "The ticket's session researched it and handed the grilling off to this session. Its handoff:",
          "",
          handoff,
        ]
      : [
          "The ticket's session researched it and handed the grilling off to this session, but the card's grilling log (`grilling.md`) reached its size limit, which cut the handoff. Read the card with `workboard_read` and the grilling log for what the ticket session found, and ask about what they leave open.",
        ]),
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
 * Gateway, with its agent's own model, that starts on the handoff.
 */
async function startNodeGrillSession(
  runtime: WorkboardNodeTicketRuntime,
  card: WorkboardCard,
  key: string,
  handoff: string | undefined,
): Promise<string> {
  const result = await runtime.request(
    "sessions.create",
    {
      key,
      ...(card.agentId ? { agentId: card.agentId } : {}),
      displayName: grillSessionName(card),
      // Groups the grill sessions in the session list, like an operator-made group.
      category: GRILL_SESSION_GROUP,
      message: grillSessionMessage(card, handoff),
    },
    { scopes: ["operator.admin"] },
  );
  const record = isRecord(result) ? result : {};
  if (record.runStarted === false) {
    throw new Error(sessionCreateRunError(record));
  }
  return typeof record.key === "string" && record.key ? record.key : key;
}

/**
 * Opens the grill session of a grilling that waits for one and records it on
 * the card, which then names it. The key names the card and the round, so a
 * pass after a create whose session was not recorded adopts the session once
 * it ran its handoff turn, instead of sending the handoff again; a session
 * whose run never started gets the create again. A session that cannot start
 * blocks the card; a move to todo brings it back to review, where the next
 * pass tries again.
 */
export async function openNodeGrillSession(params: {
  store: WorkboardStore;
  runtime: WorkboardNodeTicketRuntime;
  readSessions: WorkboardLifecycleSessionReader | undefined;
  card: WorkboardCard;
  worktree: WorkboardNodeWorktree & { grill: WorkboardNodeGrill };
  warn: (message: string) => void;
}): Promise<void> {
  const { store, card, worktree } = params;
  const round = worktree.grill.rounds;
  const name = `grill-${sanitizeSessionSegment(card.id.slice(0, 8), "card")}-${round}`;
  const key = card.agentId
    ? `agent:${sanitizeSessionSegment(card.agentId, "agent")}:${name}`
    : name;
  let sessionKey: string;
  try {
    const existing = params.readSessions
      ? (await params.readSessions({ includeUnknown: false, sessionKey: key })).sessions[0]
      : undefined;
    if (existing && sessionProvesPreparedAcceptance(existing)) {
      sessionKey = existing.key;
    } else {
      // A handoff the full log cut still opens the session, which reads the card instead.
      const log = await store.readNodeGrillLog(worktree);
      const handoff = log === undefined ? undefined : grillHandoffFromLog(log, round);
      sessionKey = await startNodeGrillSession(params.runtime, card, key, handoff);
    }
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
  const recorded = await store.setNodeGrillSession(card.id, {
    worktreePath: worktree.path,
    round,
    sessionKey,
  });
  if (!recorded) {
    params.warn(
      `workboard: grill session ${sessionKey} of card ${card.id} was not recorded; the card's grilling changed while it was created`,
    );
  }
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
