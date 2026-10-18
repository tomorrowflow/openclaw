import type { WorkboardCard } from "@openclaw/workboard-contract";
import type {
  WorkboardLifecycleSession,
  WorkboardLifecycleSessionReader,
} from "./lifecycle-sync.js";
import { nodeTicketReportOwnsRound, nodeTicketTarget } from "./node-ticket.js";
import { cardBoardId, cardRunId, cardSessionKey } from "./store-card-helpers.js";

export function sanitizeSessionSegment(value: string | undefined, fallback: string): string {
  const sanitized = (value ?? fallback)
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return (sanitized || fallback).slice(0, 96);
}

export function workboardSessionKeyForCard(card: WorkboardCard): string {
  const boardId = sanitizeSessionSegment(cardBoardId(card), "default");
  const cardId = sanitizeSessionSegment(card.id, "card");
  const suffix = `subagent:workboard-${boardId}-${cardId}`;
  return card.agentId ? `agent:${sanitizeSessionSegment(card.agentId, "agent")}:${suffix}` : suffix;
}

function sessionKeyMatchesCard(candidate: string, cardKey: string): boolean {
  return (
    candidate === cardKey ||
    (cardKey.startsWith("subagent:workboard-") && candidate.endsWith(`:${cardKey}`))
  );
}

/** A run that ended in the card's session: its id and, when known, when it started. */
type EndedRunSource = { sessionKey?: string; runId?: string; startedAt?: number };

/**
 * Whether a lifecycle event from `source` is about the card's linked run. A
 * prepared launch links a provisional run id, so any run in the session
 * matches until the launch is accepted, except one that started before the
 * round's claim: a turn still replying when the relaunch claimed the card
 * belongs to an earlier round, never to the new one.
 */
export function workboardCardMatchesLifecycleLink(
  card: WorkboardCard,
  source: EndedRunSource,
): boolean {
  const linkedSessionKey = cardSessionKey(card);
  const sessionMatches = Boolean(
    source.sessionKey &&
    (linkedSessionKey
      ? sessionKeyMatchesCard(source.sessionKey, linkedSessionKey)
      : sessionKeyMatchesCard(source.sessionKey, workboardSessionKeyForCard(card))),
  );
  const linkedRunId = cardRunId(card);
  const claimedAt = card.metadata?.claim?.claimedAt;
  if (
    source.runId !== linkedRunId &&
    claimedAt !== undefined &&
    source.startedAt !== undefined &&
    source.startedAt < claimedAt
  ) {
    return false;
  }
  if (linkedRunId && source.runId) {
    if (source.runId !== linkedRunId && !linkedRunId.startsWith(`workboard:${card.id}:`)) {
      return false;
    }
    return linkedSessionKey && source.sessionKey ? sessionMatches : true;
  }
  return sessionMatches;
}

/**
 * Whether the run that ended at `source` reports for `card`. The card's linked
 * run always does. A node ticket's stalled-turn retry of a watchdog-aborted
 * run ends in the same session under a new run id, which the link fence
 * rejects; it reports for the card's current round when it started after the
 * round's claim, which a re-dispatch renews, and no report of the round owns
 * the card yet. A run of an earlier round started before this claim. Without
 * the run's start (an `agent_end` without `durationMs`) the retry stays fenced.
 */
export function workboardCardTakesEndedRunReport(
  card: WorkboardCard,
  source: EndedRunSource,
): boolean {
  if (workboardCardMatchesLifecycleLink(card, source)) {
    return true;
  }
  const { startedAt } = source;
  const worktree = nodeTicketTarget(card)?.worktree;
  const claim = card.metadata?.claim;
  return (
    card.status === "running" &&
    worktree !== undefined &&
    claim !== undefined &&
    startedAt !== undefined &&
    startedAt >= claim.claimedAt &&
    !nodeTicketReportOwnsRound(worktree, claim.claimedAt) &&
    workboardCardMatchesLifecycleLink(card, { sessionKey: source.sessionKey })
  );
}

export function workboardCardSessionLookupKey(card: WorkboardCard): string {
  return cardSessionKey(card) ?? workboardSessionKeyForCard(card);
}

/** Whether the session owner reports a run in progress in the session. */
export async function workboardSessionHasActiveRun(
  readSessions: WorkboardLifecycleSessionReader,
  sessionKey: string,
): Promise<boolean> {
  // An exact read returns at most that session, under its canonical key.
  const {
    sessions: [session],
  } = await readSessions({ includeUnknown: false, sessionKey });
  return (
    session?.hasActiveRun === true ||
    (session?.hasActiveRun !== false && session?.status === "running")
  );
}

/** The session ran a turn: the Gateway accepted a run in it. */
export function sessionProvesPreparedAcceptance(session: WorkboardLifecycleSession): boolean {
  return (
    session.hasActiveRun === true ||
    session.status === "done" ||
    session.status === "failed" ||
    session.status === "killed" ||
    session.status === "timeout"
  );
}
