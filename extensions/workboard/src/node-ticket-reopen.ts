import type { WorkboardCard } from "@openclaw/workboard-contract";
import { markPullRequestRework, type WorkboardGitHubAccess } from "./node-ticket-publish.js";
import { nodeTicketReopen, nodeTicketReopenSubject } from "./node-ticket.js";
import {
  type WorkboardNodeTicketSlot,
  type WorkboardSlotFull,
  workboardRoutePinnedNode,
} from "./store-constants.js";
import type { WorkboardStore } from "./store.js";

/**
 * Starts one card through the dispatcher's exact start path. `request`
 * queues it while its parents are not done or its slot is full; `drain`
 * starts it only while it is queued.
 */
export type WorkboardNodeTicketStart = (
  cardId: string,
  queue: "request" | "drain",
) => Promise<{
  startFailures: ReadonlyArray<{ error: string; changed?: true }>;
  queued?: WorkboardCard;
  queuedForSlot?: WorkboardSlotFull;
}>;

/**
 * D56: a published ticket moved back to todo starts its rework round once it
 * carries a review comment, queues while the node-ticket pool is full, and
 * goes back to backlog with the next step when no review comment says what
 * should change. A ticket waiting with questions resumes the same way once a
 * comment answers them, and goes back to review without one.
 */
export async function reopenNodeTicket(params: {
  store: WorkboardStore;
  github: WorkboardGitHubAccess;
  start: WorkboardNodeTicketStart;
  card: WorkboardCard;
  now: () => number;
}): Promise<void> {
  const { store, card } = params;
  const reopen = nodeTicketReopen(card, params.now());
  if (!reopen) {
    return;
  }
  const { worktreePath, round } = reopen;
  const rework = reopen.kind === "rework";
  // A notice moves reviewFrom past the review comments, so a marking failure
  // rides on the backlog notice or is a plain comment after the start.
  const unmarked = rework
    ? await markPullRequestRework({ github: params.github, card, round })
    : undefined;
  if (!reopen.reviewed) {
    await store.addNodeTicketNotice(card.id, {
      worktreePath,
      status: rework ? "backlog" : "review",
      body: rework
        ? [
            `Reopened without a review comment; add what should change and move it to todo again to start rework round ${round}.`,
            unmarked,
          ]
            .filter(Boolean)
            .join("\n\n")
        : reopen.kind === "grill"
          ? "Moved to todo while grilling; the grilling goes on in its grill session, which the card names once it is open. Finish it there, or choose End grilling on the card to let the agent continue with the grill session's last reply, if it has one."
          : "Moved to todo without an answer; answer the questions in a comment and move it to todo again to resume the session.",
      applies: (current) => nodeTicketReopen(current, params.now())?.reviewed === false,
    });
    return;
  }
  const { startFailures, queued } = await params.start(card.id, "request");
  if (unmarked) {
    await store.addComment(card.id, { body: unmarked });
  }
  const failure = startFailures[0];
  // A start that claimed the card already blocked it on failure; only a
  // refusal before the claim leaves the reopened card in todo.
  const current = failure && !queued ? await store.get(card.id) : undefined;
  if (!failure || !current || !nodeTicketReopen(current, params.now())?.reviewed) {
    return;
  }
  const what = nodeTicketReopenSubject(reopen);
  await store.block(
    card.id,
    {
      reason: `${what} could not start: ${failure.error}\nFix the cause, then move the card to todo again.`,
    },
    null,
  );
}

export const POOL_SLOT = "pool";

/**
 * Which slot a queued card waits on: its route, and the node its worktree
 * pins it to, or the shared pool when no route matches.
 */
export function slotKey(slot: WorkboardNodeTicketSlot | undefined): string {
  const route = slot?.route;
  return route
    ? `${route.boardId}#${route.index}@${workboardRoutePinnedNode(route) ?? "*"}`
    : POOL_SLOT;
}

/**
 * Starts one queued node ticket. A card that still waits on its parents or a
 * full slot, or that changed while the start read it, stays queued for the
 * next card change; any other refusal blocks it with the reason. Returns
 * why a slot holds the card, so the pass skips later cards on that slot.
 */
export async function drainStartQueue(params: {
  store: WorkboardStore;
  start: WorkboardNodeTicketStart;
  card: WorkboardCard;
}): Promise<WorkboardSlotFull | undefined> {
  const { startFailures, queued, queuedForSlot } = await params.start(params.card.id, "drain");
  const failure = startFailures[0];
  if (!failure || queued || failure.changed) {
    return queuedForSlot;
  }
  // A start that claimed the card already blocked it on failure.
  const current = await params.store.get(params.card.id);
  if (!current?.metadata?.automation?.startRequest) {
    return undefined;
  }
  await params.store.block(
    params.card.id,
    {
      reason: `The queued start failed: ${failure.error}\nFix the cause, then start the card again.`,
    },
    null,
  );
  return undefined;
}
