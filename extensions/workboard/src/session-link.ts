import type { WorkboardCard } from "@openclaw/workboard-contract";
import { nodeTicketReportOwnsRound, nodeTicketTarget } from "./node-ticket.js";
import { cardBoardId, cardRunId, cardSessionKey } from "./store-card-helpers.js";

function sanitizeSessionSegment(value: string | undefined, fallback: string): string {
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

export function workboardCardMatchesLifecycleLink(
  card: WorkboardCard,
  source: { sessionKey?: string; runId?: string },
): boolean {
  const linkedSessionKey = cardSessionKey(card);
  const sessionMatches = Boolean(
    source.sessionKey &&
    (linkedSessionKey
      ? sessionKeyMatchesCard(source.sessionKey, linkedSessionKey)
      : sessionKeyMatchesCard(source.sessionKey, workboardSessionKeyForCard(card))),
  );
  const linkedRunId = cardRunId(card);
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
 * the run's start (an `agent_end` without `durationMs`) it stays fenced.
 */
export function workboardCardTakesEndedRunReport(
  card: WorkboardCard,
  source: { sessionKey?: string; runId?: string },
  runStartedAt: number | undefined,
): boolean {
  if (workboardCardMatchesLifecycleLink(card, source)) {
    return true;
  }
  const worktree = nodeTicketTarget(card)?.worktree;
  const claim = card.metadata?.claim;
  return (
    card.status === "running" &&
    worktree !== undefined &&
    claim !== undefined &&
    runStartedAt !== undefined &&
    runStartedAt >= claim.claimedAt &&
    !nodeTicketReportOwnsRound(worktree, claim.claimedAt) &&
    workboardCardMatchesLifecycleLink(card, { sessionKey: source.sessionKey })
  );
}

export function workboardCardSessionLookupKey(card: WorkboardCard): string {
  return cardSessionKey(card) ?? workboardSessionKeyForCard(card);
}
