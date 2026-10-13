import type { WorkboardCard } from "@openclaw/workboard-contract";
import { WorkboardNodeTicketStopStore } from "./store-node-ticket-stop.js";

export class WorkboardNodeTicketEscalationStore extends WorkboardNodeTicketStopStore {
  /**
   * Records that an agent passed a node ticket's open questions to the
   * operator, so later reviews of the same round skip it. The first escalation
   * of a round stands; the next questions round starts without one.
   */
  async escalateNodeTicketQuestions(id: string): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const result = await this.updateLatestCard(
        id,
        (card) => {
          const target = card.metadata?.automation?.target;
          const worktree = target?.worktree;
          const handoff = worktree?.handoff;
          if (!target || !worktree || handoff?.phase !== "questions") {
            throw new Error(
              "only a node ticket waiting with questions can be escalated; answer or decide other cards directly.",
            );
          }
          if (handoff.escalatedAt !== undefined) {
            return undefined;
          }
          return {
            metadata: {
              ...card.metadata,
              automation: {
                ...card.metadata?.automation,
                target: {
                  ...target,
                  worktree: { ...worktree, handoff: { ...handoff, escalatedAt: Date.now() } },
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
