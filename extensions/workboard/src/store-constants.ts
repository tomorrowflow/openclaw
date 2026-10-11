import type {
  WorkboardAutomation,
  WorkboardCard,
  WorkboardClaim,
  WorkboardExecution,
  WorkboardMetadata,
  WorkboardOrchestrationSettings,
  WorkboardTargetRoute,
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
  labels?: readonly string[];
  execution?: Pick<WorkboardExecution, "status">;
  metadata?: Pick<WorkboardMetadata, "claim" | "archivedAt"> & {
    automation?: Pick<WorkboardAutomation, "target" | "boardId">;
  };
};

/**
 * A board route's cap on its own running node tickets. Routes are read from
 * the board when a ticket claims, so a cap also holds cards created before it.
 */
export type WorkboardNodeTicketRouteSlot = {
  boardId: string;
  nodeId: string;
  limit: number;
  /** The board's routes, so a running ticket counts only toward its own first match. */
  routes: readonly Pick<WorkboardTargetRoute, "labels">[];
  index: number;
};

/**
 * The route a card's labels select: the first one sharing any of them. Card
 * creation takes its target from it and a capped route counts its tickets by it.
 */
export function findWorkboardTargetRoute<Route extends Pick<WorkboardTargetRoute, "labels">>(
  routes: readonly Route[] | undefined,
  labels: readonly string[],
): number {
  return (routes ?? []).findIndex((route) => route.labels.some((label) => labels.includes(label)));
}

/**
 * D41: node tickets share one dispatcher-wide pool sized by plugin config,
 * and a capped route also limits its own share of it; every other card holds
 * its owner's single slot.
 */
export type WorkboardClaimSlot = { kind: "owner"; ownerId: string } | WorkboardNodeTicketSlot;

export type WorkboardNodeTicketSlot = {
  kind: "node-tickets";
  limit: number;
  route?: WorkboardNodeTicketRouteSlot;
};

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

/**
 * The capped route a node ticket counts toward: the first route sharing one of
 * its labels, the same rule that picked its target, when the ticket runs on
 * that route's node.
 */
export function workboardNodeTicketRoute(
  card: WorkboardOwnerSlotCard,
  orchestration: Pick<WorkboardOrchestrationSettings, "targetRoutes"> | undefined,
): WorkboardNodeTicketRouteSlot | undefined {
  const target = card.metadata?.automation?.target;
  const routes = orchestration?.targetRoutes ?? [];
  const index = findWorkboardTargetRoute(routes, card.labels ?? []);
  const route = routes[index];
  return target && route?.maxConcurrent && route.target.nodeId === target.nodeId
    ? {
        boardId: card.metadata?.automation?.boardId ?? "default",
        nodeId: route.target.nodeId,
        limit: route.maxConcurrent,
        routes,
        index,
      }
    : undefined;
}

function workboardCardInNodeTicketRoute(
  card: WorkboardOwnerSlotCard,
  route: WorkboardNodeTicketRouteSlot,
): boolean {
  return (
    (card.metadata?.automation?.boardId ?? "default") === route.boardId &&
    card.metadata?.automation?.target?.nodeId === route.nodeId &&
    findWorkboardTargetRoute(route.routes, card.labels ?? []) === route.index
  );
}

/**
 * Which part of this slot the running cards fill, if any: the owner's slot,
 * the node-ticket pool, or the claiming ticket's route cap.
 */
export function workboardSlotFull(
  occupants: Iterable<WorkboardOwnerSlotCard>,
  slot: WorkboardClaimSlot,
  now: number,
): WorkboardSlotFull | undefined {
  if (slot.kind === "owner") {
    for (const card of occupants) {
      if (
        workboardCardConsumesOwnerSlot(card, now) &&
        workboardCardSlotOwner(card) === slot.ownerId
      ) {
        return "slot_busy";
      }
    }
    return undefined;
  }
  // Count every running ticket so a full pool is reported as such, whichever
  // limit the iteration order would reach first.
  let pool = 0;
  let route = 0;
  for (const card of occupants) {
    if (workboardCardConsumesNodeTicketSlot(card, now)) {
      pool += 1;
      if (slot.route && workboardCardInNodeTicketRoute(card, slot.route)) {
        route += 1;
      }
    }
  }
  return pool >= slot.limit
    ? "slot_busy"
    : slot.route && route >= slot.route.limit
      ? "route_busy"
      : undefined;
}

/** `route_busy` only for a node-ticket slot whose route cap is full. */
export type WorkboardSlotFull = "slot_busy" | "route_busy";

export function isWorkboardSlotFull(value: unknown): value is WorkboardSlotFull {
  return value === "slot_busy" || value === "route_busy";
}

export function workboardRouteName(route: WorkboardNodeTicketRouteSlot): string {
  return route.routes[route.index]?.labels.join(", ") ?? "";
}

export function workboardSlotBusyMessage(
  slot: WorkboardClaimSlot,
  full: WorkboardSlotFull,
): string {
  if (slot.kind === "owner") {
    return `Owner ${slot.ownerId} already has active Workboard work.`;
  }
  return full === "route_busy" && slot.route
    ? `The ${workboardRouteName(slot.route)} route's ${slot.route.limit} node ticket ${slot.route.limit === 1 ? "slot is" : "slots are"} in use; it frees when a running ticket on that route reaches review.`
    : `All ${slot.limit} node ticket slots are in use; a slot frees when a running node ticket reaches review.`;
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
