import { randomUUID } from "node:crypto";
import type { WorkboardCard } from "@openclaw/workboard-contract";
import { MAX_CARD_COMMENTS, workboardNodeTicketStartQueueable } from "./store-constants.js";
import { WorkboardWorkflowStore } from "./store-workflow.js";

export class WorkboardNodeTicketQueueStore extends WorkboardWorkflowStore {
  /**
   * Queues a node ticket's start while its slot is full, with the notice that
   * says what it waits for, in one write. A queued card keeps its first
   * request so its place in line holds. A reopened ticket's notice is noted on
   * its handoff, once per round, so it never counts as review feedback.
   */
  async requestNodeTicketStart(
    id: string,
    input: { body: string },
  ): Promise<{ card: WorkboardCard; queued: boolean }> {
    return await this.enqueueMutation(async () => {
      const now = Date.now();
      const result = await this.updateLatestCard(
        id,
        (card) => {
          const automation = card.metadata?.automation;
          if (
            !automation ||
            automation.startRequest ||
            !workboardNodeTicketStartQueueable(card, now)
          ) {
            return undefined;
          }
          const worktree = automation.target?.worktree;
          const handoff = worktree?.handoff;
          const reopened = handoff?.phase === "published" || handoff?.phase === "questions";
          const notice = !reopened || handoff.slotWaitNotedAt === undefined;
          return {
            metadata: {
              ...card.metadata,
              ...(notice
                ? {
                    comments: [
                      ...(card.metadata?.comments ?? []),
                      { id: randomUUID(), body: input.body, createdAt: now },
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
