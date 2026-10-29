import type { WorkboardCard } from "@openclaw/workboard-contract";
import { nodeTicketReopen, nodeTicketReopenSubject, nodeTicketTarget } from "./node-ticket.js";
import { cardParentIds, workboardClaimRefusal } from "./store-card-helpers.js";
import {
  type WorkboardNodeTicketSlot,
  type WorkboardSlotFull,
  workboardRouteName,
  workboardRoutePinnedNode,
  workboardSlotBusyMessage,
} from "./store-constants.js";
import type { WorkboardStore } from "./store.js";

/**
 * Why an exact node-ticket start queues instead of refusing: its parents are
 * not done or their PRs are not merged, or an open ticket touches the same
 * paths, with the refusal a start without the queue gets; or its slot is full.
 */
export type NodeTicketStartWait =
  | { kind: "dependencies"; refusal: string }
  | { kind: "touches"; tickets: OverlappingTicket[] }
  | { kind: "slot"; slot: WorkboardNodeTicketSlot; full: WorkboardSlotFull };

/**
 * The PRs of done node-ticket parents that are not merged yet: published and
 * neither merged nor closed, or not published yet. A first round cuts its
 * worktree from the default branch, so it would build without the parent's
 * work; a rework round continues its own branch and does not wait. A PR
 * closed unmerged releases the wait, since the operator dropped that work.
 */
export function unmergedParentPullRequests(
  card: WorkboardCard,
  cards: readonly WorkboardCard[],
  now: number,
): string[] {
  const parentIds = cardParentIds(card);
  if (parentIds.length === 0 || nodeTicketReopen(card, now)) {
    return [];
  }
  return parentIds.flatMap((id) => {
    const parent = cards.find((entry) => entry.id === id);
    const handoff = parent && nodeTicketTarget(parent)?.worktree?.handoff;
    // The PR state sync skips archived cards, so it would never see their merge.
    if (parent?.status !== "done" || parent.metadata?.archivedAt || !handoff) {
      return [];
    }
    if (handoff.phase === "imported") {
      return [`${parent.title} (PR not published yet)`];
    }
    if (handoff.phase !== "published") {
      return [];
    }
    const state = handoff.pullRequest?.state;
    return state === "merged" || state === "closed" ? [] : [handoff.pullRequestUrl];
  });
}

/** An open ticket a start waits for, with the first path both touch. */
type OverlappingTicket = { title: string; path: string };

// A path covers itself and, as a directory, everything under it.
function pathsOverlap(a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return long === short || long.startsWith(`${short}/`);
}

/**
 * Open node tickets whose `touches` overlap this card's, each with the first
 * shared path: tickets the pass already picks (`occupants`) and tickets with a
 * worktree whose PR has not merged or closed. A first round waits for them, so
 * sibling changes to one file land one by one instead of conflicting; a rework
 * round continues its own branch and does not wait. Archiving a ticket
 * releases the wait, like a PR closed unmerged.
 */
export function overlappingOpenTickets(
  card: WorkboardCard,
  cards: readonly WorkboardCard[],
  now: number,
  occupants: readonly WorkboardCard[] = [],
): OverlappingTicket[] {
  const touches = card.metadata?.automation?.touches ?? [];
  if (touches.length === 0 || nodeTicketReopen(card, now)) {
    return [];
  }
  const occupantIds = new Set(occupants.map((entry) => entry.id));
  return cards.flatMap((other) => {
    if (other.id === card.id || other.metadata?.archivedAt) {
      return [];
    }
    const path = touches.find((mine) =>
      other.metadata?.automation?.touches?.some((theirs) => pathsOverlap(mine, theirs)),
    );
    if (!path) {
      return [];
    }
    const worktree = nodeTicketTarget(other)?.worktree;
    const state =
      worktree?.handoff?.phase === "published" ? worktree.handoff.pullRequest?.state : undefined;
    const open =
      occupantIds.has(other.id) ||
      (worktree !== undefined && state !== "merged" && state !== "closed");
    return open ? [{ title: other.title, path }] : [];
  });
}

/** The refusal a start without the queue gets for this wait. */
export function nodeTicketStartWaitRefusal(wait: NodeTicketStartWait): string {
  switch (wait.kind) {
    case "dependencies":
      return wait.refusal;
    case "touches":
      return `Card waits for open tickets touching the same paths to merge: ${overlapList(wait.tickets)}.`;
    case "slot":
      return workboardSlotBusyMessage(wait.slot, wait.full);
  }
}

function overlapList(tickets: readonly OverlappingTicket[]): string {
  return tickets.map(({ title, path }) => `${title} (${path})`).join(", ");
}

/**
 * Why a node-ticket start waits on its parents or on open tickets touching
 * its paths. Unfinished parents are the one claim refusal it may queue on,
 * since the claim accepts it once they are done; a start the claim accepts
 * still waits for the parents' unmerged PRs and for the overlapping tickets.
 */
export function nodeTicketDependencyWait(
  card: WorkboardCard,
  cards: readonly WorkboardCard[],
  now: number,
  claimRefusal: string | undefined,
  occupants: readonly WorkboardCard[] = [],
): NodeTicketStartWait | undefined {
  if (claimRefusal) {
    return workboardClaimRefusal(card, false, true)
      ? undefined
      : { kind: "dependencies", refusal: claimRefusal };
  }
  const unmerged = unmergedParentPullRequests(card, cards, now);
  if (unmerged.length > 0) {
    return {
      kind: "dependencies",
      refusal: `Card waits for its parents' PRs to merge: ${unmerged.join(", ")}.`,
    };
  }
  const tickets = overlappingOpenTickets(card, cards, now, occupants);
  return tickets.length > 0 ? { kind: "touches", tickets } : undefined;
}

/** Queues a start that has to wait; the card when the request was recorded. */
export async function queueNodeTicketStart(
  store: WorkboardStore,
  cardId: string,
  wait: NodeTicketStartWait,
  now: number,
): Promise<WorkboardCard | undefined> {
  const cards = wait.kind === "dependencies" ? await store.list() : [];
  const request = await store.requestNodeTicketStart(cardId, {
    notice: (card) => nodeTicketStartWaitNotice(card, wait, cards, now),
  });
  return request.queued ? request.card : undefined;
}

/**
 * Queues the ready node tickets a scheduled pass skips until their parents'
 * PRs or the open tickets touching their paths merge, so they show why they
 * wait instead of sitting in ready.
 */
export async function queueMergeWaits(
  store: WorkboardStore,
  candidates: readonly WorkboardCard[],
  cards: readonly WorkboardCard[],
  nodeTicketSlots: ReadonlyMap<string, WorkboardNodeTicketSlot>,
  now: number,
): Promise<void> {
  for (const card of candidates) {
    const wait =
      card.status === "ready" &&
      !card.metadata?.automation?.startRequest &&
      nodeTicketSlots.has(card.id)
        ? nodeTicketDependencyWait(card, cards, now, undefined)
        : undefined;
    if (wait) {
      await queueNodeTicketStart(store, card.id, wait, now);
    }
  }
}

/** What a queued node ticket's notice says it waits for; `cards` resolves parent titles. */
export function nodeTicketStartWaitNotice(
  card: WorkboardCard,
  wait: NodeTicketStartWait,
  cards: readonly WorkboardCard[],
  now: number,
): string {
  const reopen = nodeTicketReopen(card, now);
  const what = reopen ? nodeTicketReopenSubject(reopen) : "This ticket";
  if (wait.kind === "touches") {
    return `${what} waits for open tickets touching the same paths: ${overlapList(wait.tickets)}. It starts once their PRs are merged or closed (the board reads PR states from GitHub every 10 minutes) or they are archived, and a node-ticket slot is free.`;
  }
  if (wait.kind === "dependencies") {
    const byId = new Map(cards.map((entry) => [entry.id, entry]));
    const parents = cardParentIds(card).flatMap((id) => {
      const parent = byId.get(id);
      return parent?.status === "done" ? [] : [parent?.title ?? id];
    });
    if (parents.length === 0) {
      return `${what} waits for its parents' PRs to merge: ${unmergedParentPullRequests(card, cards, now).join(", ")}. Its worktree starts from the default branch, so it starts once they are merged (the board reads PR states from GitHub every 10 minutes) and a node-ticket slot is free.`;
    }
    return `${what} waits for its dependencies: ${parents.join(", ")}. It starts when they are done, their PRs are merged, and a node-ticket slot is free.`;
  }
  const route = wait.full === "route_busy" ? wait.slot.route : undefined;
  if (!route) {
    return `${what} waits for a node-ticket slot; it starts when a running node ticket reaches review.`;
  }
  const name = workboardRouteName(route);
  const pinned = workboardRoutePinnedNode(route);
  return pinned
    ? `${what} waits for a slot on node ${pinned}, where its worktree is, on the ${name} route; it starts when a running ticket of that route on ${pinned} reaches review.`
    : `${what} waits for a slot on the ${name} route; it starts when a running ticket on that route reaches review.`;
}
