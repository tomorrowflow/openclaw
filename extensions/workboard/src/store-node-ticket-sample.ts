import type { WorkboardCard } from "@openclaw/workboard-contract";
import { WorkboardNodeTicketEscalationStore } from "./store-node-ticket-escalation.js";

export class WorkboardNodeTicketSampleStore extends WorkboardNodeTicketEscalationStore {
  /**
   * Records that the operator read the PR of a published round an agent
   * accepted into the human review sample. Workboard never sees the merge, so
   * this read is what takes the PR off the operator's list. The first read of
   * a round stands; a rework round publishes a new review entry without one.
   */
  async readNodeTicketSample(id: string): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const result = await this.updateLatestCard(
        id,
        (card) => {
          const target = card.metadata?.automation?.target;
          const worktree = target?.worktree;
          const reviews = worktree?.reviews ?? [];
          const latest = reviews.at(-1);
          if (
            !target ||
            !worktree ||
            worktree.handoff?.phase !== "published" ||
            !latest?.sampled ||
            latest.decidedBy !== "agent"
          ) {
            throw new Error(
              "only a published node ticket an agent accepted into the review sample can be marked read.",
            );
          }
          if (latest.readAt !== undefined) {
            return undefined;
          }
          return {
            metadata: {
              ...card.metadata,
              automation: {
                ...card.metadata?.automation,
                target: {
                  ...target,
                  worktree: {
                    ...worktree,
                    reviews: [...reviews.slice(0, -1), { ...latest, readAt: Date.now() }],
                  },
                },
              },
            },
          };
        },
        { allowAutomationLaunch: true },
      );
      return result.card;
    });
  }
}
