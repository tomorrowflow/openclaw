import type {
  WorkboardAutomation,
  WorkboardCard,
  WorkboardClaim,
  WorkboardClassRung,
  WorkboardExecution,
  WorkboardExecutionTarget,
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
export const MAX_RUN_ID_LENGTH = 512;
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
/** The smart zone (draft D16): ~20% of a frontier context window. */
export const SMART_ZONE_TOKENS = 150_000;

type WorkboardOwnerSlotCard = Pick<WorkboardCard, "status" | "agentId"> & {
  labels?: readonly string[];
  execution?: Pick<WorkboardExecution, "status">;
  metadata?: Pick<WorkboardMetadata, "claim" | "archivedAt"> & {
    automation?: Pick<WorkboardAutomation, "target" | "boardId">;
  };
};

export type WorkboardRouteTarget = Omit<WorkboardExecutionTarget, "worktree">;

/**
 * A board route's per-node cap on its own running node tickets. Routes are
 * read from the board when a ticket claims, so a cap also holds cards created
 * before it.
 */
export type WorkboardNodeTicketRouteSlot = {
  boardId: string;
  /**
   * The nodes this ticket may claim on, in preference order: the route's
   * whole pool for a ticket that has no worktree yet, else only its own node.
   */
  targets: readonly WorkboardRouteTarget[];
  /** How many nodes the route has, so a waiting ticket pinned to one of them names it. */
  nodes: number;
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

/** A card's task class: its first `class:<name>` label, without the prefix. */
export function workboardTaskClass(labels: readonly string[]): string | undefined {
  return (
    labels
      .find((label) => label.startsWith("class:"))
      ?.slice("class:".length)
      .trim() || undefined
  );
}

/** The board's rung entry for a card's task class; no entry means rung a. */
export function workboardClassRung(
  orchestration: Pick<WorkboardOrchestrationSettings, "classRungs"> | undefined,
  labels: readonly string[],
): WorkboardClassRung | undefined {
  const taskClass = workboardTaskClass(labels);
  const classRungs = orchestration?.classRungs;
  return taskClass && classRungs && Object.hasOwn(classRungs, taskClass)
    ? classRungs[taskClass]
    : undefined;
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

/**
 * Whether a node ticket may hold a queued start request: it waits unclaimed in
 * todo, or in ready once its parents are done, and is not archived.
 */
export function workboardNodeTicketStartQueueable(
  card: WorkboardOwnerSlotCard,
  now: number,
): boolean {
  const claim = card.metadata?.claim;
  return (
    isWorkboardNodeTicket(card) &&
    (card.status === "todo" || card.status === "ready") &&
    !card.metadata?.archivedAt &&
    !(claim && isFutureDateTimestampMs(claim.expiresAt, { nowMs: now }))
  );
}

/**
 * The card without its queued start once it can no longer hold one; a move
 * away cancels the request, so moving the card back never starts it.
 */
export function withoutStaleStartRequest(card: WorkboardCard, now: number): WorkboardCard {
  const automation = card.metadata?.automation;
  if (!automation?.startRequest || workboardNodeTicketStartQueueable(card, now)) {
    return card;
  }
  const { startRequest: _cancelled, ...rest } = automation;
  return { ...card, metadata: { ...card.metadata, automation: rest } };
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

/** The card on another node of its route; only a card without a worktree is placed. */
export function withWorkboardRouteTarget(
  card: WorkboardCard,
  target: WorkboardRouteTarget,
): WorkboardCard {
  return {
    ...card,
    metadata: { ...card.metadata, automation: { ...card.metadata?.automation, target } },
  };
}

/** A route's nodes in preference order: its target, then its alternates. */
export function workboardRouteTargets(route: WorkboardTargetRoute): WorkboardRouteTarget[] {
  return [route.target, ...(route.alternateTargets ?? [])];
}

/**
 * The capped route a node ticket counts toward: the first route sharing one of
 * its labels, the same rule that picked its target, when the ticket runs on
 * one of that route's nodes.
 */
export function workboardNodeTicketRoute(
  card: WorkboardOwnerSlotCard,
  orchestration: Pick<WorkboardOrchestrationSettings, "targetRoutes"> | undefined,
): WorkboardNodeTicketRouteSlot | undefined {
  const target = card.metadata?.automation?.target;
  const routes = orchestration?.targetRoutes ?? [];
  const index = findWorkboardTargetRoute(routes, card.labels ?? []);
  const route = routes[index];
  const pool = route ? workboardRouteTargets(route) : [];
  const own = target && pool.find((candidate) => candidate.nodeId === target.nodeId);
  if (!target || !own || !route?.maxConcurrent) {
    return undefined;
  }
  // A ticket without a worktree may start on any of the route's nodes; once
  // it has one, it stays on its node.
  return {
    boardId: card.metadata?.automation?.boardId ?? "default",
    targets: target.worktree ? [own] : pool,
    nodes: pool.length,
    limit: route.maxConcurrent,
    routes,
    index,
  };
}

/**
 * Whether the slot has room and, for a capped route, the first of its nodes
 * below the per-node cap. `full` names the pool or the route; `target` is
 * the node the claiming ticket runs on.
 */
export function workboardSlotPlacement(
  occupants: Iterable<WorkboardOwnerSlotCard>,
  slot: WorkboardClaimSlot,
  now: number,
):
  | { full: WorkboardSlotFull; target?: undefined }
  | { full?: undefined; target?: WorkboardRouteTarget } {
  if (slot.kind === "owner") {
    for (const card of occupants) {
      if (
        workboardCardConsumesOwnerSlot(card, now) &&
        workboardCardSlotOwner(card) === slot.ownerId
      ) {
        return { full: "slot_busy" };
      }
    }
    return {};
  }
  // Count every running ticket so a full pool is reported as such, whichever
  // limit the iteration order would reach first.
  const route = slot.route;
  let pool = 0;
  const perNode = new Map<string, number>();
  for (const card of occupants) {
    if (!workboardCardConsumesNodeTicketSlot(card, now)) {
      continue;
    }
    pool += 1;
    const nodeId = card.metadata?.automation?.target?.nodeId;
    if (
      route &&
      nodeId &&
      (card.metadata?.automation?.boardId ?? "default") === route.boardId &&
      findWorkboardTargetRoute(route.routes, card.labels ?? []) === route.index
    ) {
      perNode.set(nodeId, (perNode.get(nodeId) ?? 0) + 1);
    }
  }
  if (pool >= slot.limit) {
    return { full: "slot_busy" };
  }
  if (!route) {
    return {};
  }
  const target = route.targets.find(
    (candidate) => (perNode.get(candidate.nodeId) ?? 0) < route.limit,
  );
  return target ? { target } : { full: "route_busy" };
}

/** `route_busy` only for a node-ticket slot whose route cap is full. */
export type WorkboardSlotFull = "slot_busy" | "route_busy";

export function isWorkboardSlotFull(value: unknown): value is WorkboardSlotFull {
  return value === "slot_busy" || value === "route_busy";
}

export function workboardRouteName(route: WorkboardNodeTicketRouteSlot): string {
  return route.routes[route.index]?.labels.join(", ") ?? "";
}

/** The node a ticket's worktree holds it to when its route has several. */
export function workboardRoutePinnedNode(route: WorkboardNodeTicketRouteSlot): string | undefined {
  return route.nodes > 1 && route.targets.length === 1 ? route.targets[0]?.nodeId : undefined;
}

export function workboardSlotBusyMessage(
  slot: WorkboardClaimSlot,
  full: WorkboardSlotFull,
): string {
  if (slot.kind === "owner") {
    return `Owner ${slot.ownerId} already has active Workboard work.`;
  }
  if (full !== "route_busy" || !slot.route) {
    return `All ${slot.limit} node ticket slots are in use; a slot frees when a running node ticket reaches review.`;
  }
  const route = slot.route;
  const name = workboardRouteName(route);
  const slots = `${route.limit} node ticket ${route.limit === 1 ? "slot" : "slots"}`;
  const pinned = workboardRoutePinnedNode(route);
  if (pinned) {
    return `The ${name} route's ${slots} on node ${pinned}, where this ticket's worktree is, ${route.limit === 1 ? "is" : "are"} in use; it frees when a running ticket of that route on ${pinned} reaches review.`;
  }
  return route.targets.length > 1
    ? `Each of the ${name} route's ${route.targets.length} nodes has its ${slots} in use; one frees when a running ticket on that route reaches review.`
    : `The ${name} route's ${slots} ${route.limit === 1 ? "is" : "are"} in use; it frees when a running ticket on that route reaches review.`;
}

/** The card's status, board, agent, workspace, or target changed after the start read it. */
export class WorkboardClaimAuthorityChangedError extends Error {
  constructor() {
    super("card workspace authority changed before claim.");
    this.name = "WorkboardClaimAuthorityChangedError";
  }
}

/** A claim refused only because its slot is full; the card is unchanged. */
export class WorkboardSlotFullError extends Error {
  constructor(
    readonly slot: WorkboardClaimSlot,
    readonly full: WorkboardSlotFull,
  ) {
    super(workboardSlotBusyMessage(slot, full));
    this.name = "WorkboardSlotFullError";
  }
}

/** Throws a claim's slot-full refusal as {@link WorkboardSlotFullError}. */
export function assertWorkboardSlotClaimed<Result>(
  slot: WorkboardClaimSlot,
  result: Result,
): asserts result is Exclude<Result, WorkboardSlotFull> {
  if (isWorkboardSlotFull(result)) {
    throw new WorkboardSlotFullError(slot, result);
  }
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
