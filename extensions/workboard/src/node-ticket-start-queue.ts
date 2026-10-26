import type { WorkboardCard } from "@openclaw/workboard-contract";
import { nodeTicketReopen, nodeTicketReopenSubject } from "./node-ticket.js";
import { cardParentIds } from "./store-card-helpers.js";
import {
  type WorkboardNodeTicketSlot,
  type WorkboardSlotFull,
  workboardRouteName,
  workboardRoutePinnedNode,
} from "./store-constants.js";
import type { WorkboardStore } from "./store.js";

/**
 * Why an exact node-ticket start queues instead of refusing: its parents are
 * not done, with the refusal a start without the queue gets, or its slot is
 * full.
 */
export type NodeTicketStartWait =
  | { kind: "dependencies"; refusal: string }
  | { kind: "slot"; slot: WorkboardNodeTicketSlot; full: WorkboardSlotFull };

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
    return `${what} waits for its dependencies: ${parents.join(", ")}. It starts when they are done and a node-ticket slot is free.`;
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
