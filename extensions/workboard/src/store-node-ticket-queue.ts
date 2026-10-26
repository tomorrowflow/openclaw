import { randomUUID } from "node:crypto";
import type { WorkboardCard } from "@openclaw/workboard-contract";
import { nodeTicketReopen } from "./node-ticket.js";
import { MAX_CARD_COMMENTS, workboardNodeTicketStartQueueable } from "./store-constants.js";
import { WorkboardWorkflowStore } from "./store-workflow.js";

export class WorkboardNodeTicketQueueStore extends WorkboardWorkflowStore {
  /**
   * Queues a node ticket's start that has to wait, with the notice that
   * says what it waits for, in one write. A queued card keeps its first
   * request so its place in line holds. A reopened ticket's notice is noted on
   * its handoff, once per round, so it never counts as review feedback.
   * Queueing a backlog card moves it to todo in the same write, so moving it
   * back to backlog stays the way to cancel. A reopen without review feedback
   * is not queued; the D56 handoff sends it back with the next step.
   */
  async requestNodeTicketStart(
    id: string,
    input: { notice: (card: WorkboardCard) => string },
  ): Promise<{ card: WorkboardCard; queued: boolean }> {
    return await this.enqueueMutation(async () => {
      const now = Date.now();
      const result = await this.updateLatestCard(
        id,
        (card) => {
          const automation = card.metadata?.automation;
          const queued: WorkboardCard =
            card.status === "backlog" ? { ...card, status: "todo" } : card;
          if (
            !automation ||
            automation.startRequest ||
            !workboardNodeTicketStartQueueable(queued, now) ||
            nodeTicketReopen(queued, now)?.reviewed === false
          ) {
            return undefined;
          }
          const worktree = automation.target?.worktree;
          const handoff = worktree?.handoff;
          const reopened =
            handoff?.phase === "published" ||
            handoff?.phase === "questions" ||
            handoff?.phase === "grilling";
          const notice = !reopened || handoff.slotWaitNotedAt === undefined;
          return {
            ...(queued.status !== card.status ? { status: queued.status } : {}),
            metadata: {
              ...card.metadata,
              ...(notice
                ? {
                    comments: [
                      ...(card.metadata?.comments ?? []),
                      { id: randomUUID(), body: input.notice(queued), createdAt: now },
                    ].slice(-MAX_CARD_COMMENTS),
                  }
                : {}),
              automation: {
                ...automation,
                startRequest: { requestedAt: now },
                ...(reopened && notice && automation.target && worktree
                  ? {
                      target: {
                        ...automation.target,
                        worktree: { ...worktree, handoff: { ...handoff, slotWaitNotedAt: now } },
                      },
                    }
                  : {}),
              },
            },
          };
        },
        { allowAutomationLaunch: true },
      );
      return {
        card: result.card,
        queued: Boolean(result.card.metadata?.automation?.startRequest),
      };
    });
  }
}
