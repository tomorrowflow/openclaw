import type { WorkboardCard } from "@openclaw/workboard-contract";
import { appendComment, cardSessionKey, closeRunningAttempts } from "./store-card-helpers.js";
import { WorkboardNodeTicketQueueStore } from "./store-node-ticket-queue.js";

const NODE_TICKET_STOPPED_NOTICE =
  "Stopped by the operator. Restart continues in the same worktree with its uncommitted edits.";

export class WorkboardNodeTicketStopStore extends WorkboardNodeTicketQueueStore {
  /**
   * An operator stop of a running node ticket. `request` records it on the
   * worktree before the caller aborts the session, so the run's end is not
   * taken for a failure. `settle` closes it: a still-running card goes back to
   * todo with its worktree and session link kept and the attempt closed as
   * stopped, with no failure counted; `aborted: false` drops the request.
   * `updated` is false when a request found a stop already in flight.
   */
  async nodeTicketStop(
    id: string,
    input:
      | { action: "request"; expectedUpdatedAt?: number }
      | { action: "settle"; aborted: boolean },
  ): Promise<{ card: WorkboardCard; updated: boolean }> {
    return await this.enqueueMutation(async () => {
      const result = await this.updateLatestCard(
        id,
        (card) => {
          const target = card.metadata?.automation?.target;
          const worktree = target?.worktree;
          if (input.action === "request") {
            if (card.status !== "running" || !target || !worktree || !cardSessionKey(card)) {
              throw new Error("only a running node ticket with a session can be stopped.");
            }
            if (worktree.stopRequestedAt !== undefined) {
              return undefined;
            }
          } else if (!target || worktree?.stopRequestedAt === undefined) {
            return undefined;
          }
          // The run's end may already have settled the stop.
          if (input.action === "settle" && card.status === "todo") {
            return undefined;
          }
          const now = Date.now();
          // A done report that still arrived owns the card through its pending import.
          const stopped =
            input.action === "settle" &&
            input.aborted &&
            card.status === "running" &&
            !worktree.handoff;
          const { stopRequestedAt: _dropped, ...rest } = worktree;
          const metadata = {
            ...card.metadata,
            automation: {
              ...card.metadata?.automation,
              target: {
                ...target,
                // A stop keeps its mark until the next launch; a dropped request leaves none.
                worktree:
                  input.action === "request"
                    ? { ...worktree, stopRequestedAt: now }
                    : stopped
                      ? worktree
                      : rest,
              },
            },
          };
          if (!stopped) {
            return { metadata };
          }
          return {
            status: "todo",
            ...(card.execution
              ? { execution: { ...card.execution, status: "idle" as const, updatedAt: now } }
              : {}),
            metadata: {
              ...metadata,
              claim: undefined,
              attempts: closeRunningAttempts(metadata.attempts, now, "stopped"),
              comments: appendComment(metadata.comments, NODE_TICKET_STOPPED_NOTICE, now),
            },
          };
        },
        {
          allowAutomationLaunch: true,
          ...(input.action === "request" && input.expectedUpdatedAt !== undefined
            ? { expectedUpdatedAt: input.expectedUpdatedAt }
            : {}),
        },
      );
      return result;
    });
  }
}
