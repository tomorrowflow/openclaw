import type { WorkboardCard } from "@openclaw/workboard-contract";
import { nodeTicketStartRequestPatch } from "./node-ticket-start-queue.js";
import { WorkboardWorkflowStore } from "./store-workflow.js";

export class WorkboardNodeTicketQueueStore extends WorkboardWorkflowStore {
  /**
   * Queues a node ticket's start that has to wait, with the notice that
   * says what it waits for, in one write. A queued card keeps its first
   * request so its place in line holds. Queueing a backlog card moves it to
   * todo in the same write, so moving it back to backlog stays the way to
   * cancel.
   */
  async requestNodeTicketStart(
    id: string,
    input: { notice: (card: WorkboardCard) => string },
  ): Promise<{ card: WorkboardCard; queued: boolean }> {
    return await this.enqueueMutation(async () => {
      const now = Date.now();
      const result = await this.updateLatestCard(
        id,
        (card) =>
          card.metadata?.automation?.startRequest
            ? undefined
            : nodeTicketStartRequestPatch(
                card.status === "backlog" ? { ...card, status: "todo" } : card,
                { requestedAt: now },
                input.notice,
                now,
              ),
        { allowAutomationLaunch: true },
      );
      return {
        card: result.card,
        queued: Boolean(result.card.metadata?.automation?.startRequest),
      };
    });
  }

  /**
   * Changes the model a node ticket runs on. Each start passes the target's
   * model to the session, so the next start applies it; the worktree, node and
   * repo stay as they are. A running card keeps its model until it stops.
   */
  async setTargetModel(id: string, model: string): Promise<WorkboardCard> {
    const requested = model.trim();
    if (!requested.includes("/")) {
      throw new Error("model must be a provider/model reference.");
    }
    return await this.enqueueMutation(async () => {
      const card = await this.requireCard(id);
      const automation = card.metadata?.automation;
      const target = automation?.target;
      if (!automation || target?.kind !== "node-claude") {
        throw new Error("only node ticket cards have a model to change.");
      }
      if (card.status === "running" || card.metadata?.claim) {
        throw new Error("stop the card before changing its model.");
      }
      const refusal = this.checkTargetModel?.({ agentId: card.agentId, model: requested });
      if (refusal) {
        throw new Error(`model ${requested} is not allowed for this card's agent (${refusal}).`);
      }
      if (target.model === requested) {
        return card;
      }
      return await this.updateCard(
        card,
        {
          metadata: {
            ...card.metadata,
            automation: { ...automation, target: { ...target, model: requested } },
          },
        },
        { expectedUpdatedAt: card.updatedAt },
      );
    });
  }
}
