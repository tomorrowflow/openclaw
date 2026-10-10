import type {
  WorkboardAutomation,
  WorkboardCard,
  WorkboardClaim,
  WorkboardExecution,
  WorkboardMetadata,
} from "@openclaw/workboard-contract";
import {
  isFutureDateTimestampMs,
  MAX_DATE_TIMESTAMP_MS,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";

export const POSITION_STEP = 1000;
export const MAX_CARDS = 2000;
export const MAX_CARD_EVENTS = 50;
export const MAX_CARD_ATTEMPTS = 30;
export const MAX_CARD_COMMENTS = 50;
export const MAX_CARD_LINKS = 50;
export const MAX_CARD_PROOF = 40;
export const MAX_CARD_ARTIFACTS = 40;
export const MAX_CARD_ATTACHMENTS = 20;
export const MAX_CARD_WORKER_LOGS = 40;
export const MAX_WORKER_CONTEXT_PARENTS = 6;
export const MAX_WORKER_CONTEXT_RECENT_CARDS = 5;
export const MAX_ATTACHMENT_BYTES = 256 * 1024;
export const MAX_CARD_DIAGNOSTICS = 12;
export const MAX_CARD_NOTIFICATIONS = 20;
export const MAX_NODE_REVIEW_VERDICTS = 20;
export const MAX_CARD_METADATA_BYTES = 24 * 1024;
export const MAX_ATTEMPT_ERROR_CHARS = 800;
export const MAX_BLOCK_REASON_CHARS = 2000;
export const MAX_COMMENT_BODY_CHARS = 2000;
export const MAX_PROOF_COMMAND_CHARS = 1000;
export const MAX_PROOF_NOTE_CHARS = 2000;
export const DEFAULT_CLAIM_TTL_MS = 30 * 60 * 1000;
export const DEFAULT_WORKBOARD_DISPATCH_OWNER = "workboard-dispatcher";
export const READY_STRANDED_MS = 60 * 60 * 1000;
export const RUNNING_HEARTBEAT_STALE_MS = 20 * 60 * 1000;
export const BLOCKED_TOO_LONG_MS = 24 * 60 * 60 * 1000;
const CLAIM_RECLAIM_MS = 5 * 60 * 1000;

export function isWorkboardClaimReclaimable(
  claim: WorkboardClaim | undefined,
  now: number,
): boolean {
  return Boolean(claim?.expiresAt && now - claim.expiresAt > CLAIM_RECLAIM_MS);
}

export const DEFAULT_NODE_TICKET_CONCURRENCY = 2;

type WorkboardOwnerSlotCard = Pick<WorkboardCard, "status" | "agentId"> & {
  execution?: Pick<WorkboardExecution, "status">;
  metadata?: Pick<WorkboardMetadata, "claim" | "archivedAt"> & {
    automation?: Pick<WorkboardAutomation, "target">;
  };
};

/**
 * D41: node tickets share one dispatcher-wide pool sized by plugin config;
 * every other card holds its owner's single slot.
 */
export type WorkboardClaimSlot =
  | { kind: "owner"; ownerId: string }
  | { kind: "node-tickets"; limit: number };

export function isWorkboardNodeTicket(card: WorkboardOwnerSlotCard): boolean {
  return card.metadata?.automation?.target?.kind === "node-claude";
}

export function workboardCardConsumesOwnerSlot(card: WorkboardOwnerSlotCard, now: number): boolean {
  const claim = card.metadata?.claim;
  const activeClaim = claim && isFutureDateTimestampMs(claim.expiresAt, { nowMs: now });
  return (
    !isWorkboardNodeTicket(card) &&
    !card.metadata?.archivedAt &&
    !isWorkboardClaimReclaimable(claim, now) &&
    (card.status === "running" ||
      (card.status !== "done" && activeClaim) ||
      card.execution?.status === "running")
  );
}

/**
 * A node ticket holds a pool slot only while its turn and import run. In
 * review it waits on a human, not a node, so an un-accepted PR never blocks
 * the next ticket (D52).
 */
export function workboardCardConsumesNodeTicketSlot(
  card: WorkboardOwnerSlotCard,
  now: number,
): boolean {
  return (
    isWorkboardNodeTicket(card) &&
    card.status === "running" &&
    !card.metadata?.archivedAt &&
    !isWorkboardClaimReclaimable(card.metadata?.claim, now)
  );
}

export function workboardCardOccupiesSlot(
  card: WorkboardOwnerSlotCard,
  slot: WorkboardClaimSlot,
  now: number,
): boolean {
  return slot.kind === "node-tickets"
    ? workboardCardConsumesNodeTicketSlot(card, now)
    : workboardCardConsumesOwnerSlot(card, now) && workboardCardSlotOwner(card) === slot.ownerId;
}

export function workboardSlotBusyMessage(slot: WorkboardClaimSlot): string {
  return slot.kind === "node-tickets"
    ? `All ${slot.limit} node ticket slots are in use; a slot frees when a running node ticket reaches review.`
    : `Owner ${slot.ownerId} already has active Workboard work.`;
}

export function workboardCardSlotOwner(card: WorkboardOwnerSlotCard, now?: number): string {
  const claim = card.metadata?.claim;
  // Ready candidates pass now to ignore expired claims. Occupied slots omit it
  // so the claim owner keeps its slot through the heartbeat-reclaim grace period.
  return (
    (claim && (now === undefined || isFutureDateTimestampMs(claim.expiresAt, { nowMs: now }))
      ? claim.ownerId
      : undefined) ||
    card.agentId ||
    DEFAULT_WORKBOARD_DISPATCH_OWNER
  );
}

export function secondsToDurationMs(seconds: number): number {
  const ms = Math.trunc(seconds) * 1000;
  return Number.isFinite(ms)
    ? Math.min(MAX_DATE_TIMESTAMP_MS, Math.max(1, ms))
    : MAX_DATE_TIMESTAMP_MS;
}

export function addWorkboardDurationMs(now: number, durationMs: number): number {
  return resolveExpiresAtMsFromDurationMs(durationMs, { nowMs: now }) ?? MAX_DATE_TIMESTAMP_MS;
}
