import type {
  WorkboardAttemptStatus,
  WorkboardCard,
  WorkboardRunAttempt,
} from "@openclaw/workboard-contract";
import { NODE_TICKET_SETTLED_WITHOUT_REPORT, nodeTicketIdleVerdict } from "./node-ticket.js";
import {
  appendComment,
  cardRunId,
  cardSessionKey,
  closeRunningAttempts,
} from "./store-card-helpers.js";
import { MAX_ATTEMPT_ERROR_CHARS } from "./store-constants.js";
import { WorkboardNodeTicketQueueStore } from "./store-node-ticket-queue.js";
import { capText } from "./store-normalizers.js";

const NODE_TICKET_STOPPED_NOTICE =
  "Stopped by the operator. Restart continues in the same worktree with its uncommitted edits.";

/** The run's attempt at `from` carrying `outcome`; other attempts as recorded. */
function withRunAttempt(
  attempts: WorkboardRunAttempt[] | undefined,
  runId: string | undefined,
  from: WorkboardAttemptStatus,
  outcome: Partial<WorkboardRunAttempt>,
): WorkboardRunAttempt[] | undefined {
  const index =
    attempts?.findIndex((attempt) => attempt.runId === runId && attempt.status === from) ?? -1;
  const attempt = attempts?.[index];
  return attempts && attempt ? attempts.with(index, { ...attempt, ...outcome }) : attempts;
}

export class WorkboardNodeTicketStopStore extends WorkboardNodeTicketQueueStore {
  /**
   * Applies `nodeTicketIdleVerdict` to a running node ticket the sweep found
   * idle: restarts the wait when the session moved, or blocks the card naming
   * the next step. Judged on the latest row, before this sweep's lifecycle
   * write, so a report or re-run that landed since wins. True when blocked.
   */
  async settleIdleNodeTicket(id: string, sessionUpdatedAt: number | undefined): Promise<boolean> {
    return await this.enqueueMutation(async () => {
      let blocked = false;
      await this.updateLatestCard(id, (card) => {
        const verdict = nodeTicketIdleVerdict(card, sessionUpdatedAt);
        // A conflict retry reruns this on the newer row; the last run decides.
        blocked = verdict === "block";
        const now = Date.now();
        if (verdict === "observe" && card.execution && sessionUpdatedAt !== undefined) {
          return {
            execution: { ...card.execution, updatedAt: Math.max(now, sessionUpdatedAt) },
          };
        }
        if (!blocked) {
          return undefined;
        }
        const reason = NODE_TICKET_SETTLED_WITHOUT_REPORT;
        const patch = this.buildBlockedCardPatch(card, reason, now);
        // The idle observation closed this run's attempt as stopped; the block is its outcome.
        return {
          ...patch,
          ...(card.execution
            ? { execution: { ...card.execution, status: "blocked" as const, updatedAt: now } }
            : {}),
          metadata: {
            ...patch.metadata,
            attempts: withRunAttempt(patch.metadata.attempts, cardRunId(card), "stopped", {
              status: "blocked",
              endedAt: now,
              error: capText(reason, MAX_ATTEMPT_ERROR_CHARS),
            }),
          },
        };
      });
      return blocked;
    });
  }

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
