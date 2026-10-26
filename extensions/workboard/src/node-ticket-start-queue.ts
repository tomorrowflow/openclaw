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
 * not done or their PRs are not merged, with the refusal a start without the
 * queue gets, or its slot is full.
 */
export type NodeTicketStartWait =
  | { kind: "dependencies"; refusal: string }
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

/** The refusal a start without the queue gets for this wait. */
export function nodeTicketStartWaitRefusal(wait: NodeTicketStartWait): string {
  return wait.kind === "dependencies"
    ? wait.refusal
    : workboardSlotBusyMessage(wait.slot, wait.full);
}

/**
 * Why a node-ticket start waits on its parents. Unfinished parents are the one
 * claim refusal it may queue on, since the claim accepts it once they are
 * done; a start the claim accepts still waits for the parents' unmerged PRs.
 */
export function nodeTicketDependencyWait(
  card: WorkboardCard,
  cards: readonly WorkboardCard[],
  now: number,
  claimRefusal: string | undefined,
): NodeTicketStartWait | undefined {
  if (claimRefusal) {
    return workboardClaimRefusal(card, false, true)
      ? undefined
      : { kind: "dependencies", refusal: claimRefusal };
  }
  const unmerged = unmergedParentPullRequests(card, cards, now);
  return unmerged.length > 0
    ? {
        kind: "dependencies",
        refusal: `Card waits for its parents' PRs to merge: ${unmerged.join(", ")}.`,
      }
    : undefined;
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
 * PRs merge, so they show why they wait instead of sitting in ready.
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
