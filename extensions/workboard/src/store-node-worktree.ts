import type { WorkboardCard, WorkboardNodeWorktree } from "@openclaw/workboard-contract";
import { type WorkboardNodeRoundFacts, withNodeRound } from "./node-ticket-rounds.js";
import { assertCanMutateClaimedCard } from "./store-card-helpers.js";
import type { WorkboardMutationScope } from "./store-inputs.js";
import { WorkboardNotificationStore } from "./store-notifications.js";
import { type WorkboardNodeHandoffInput, withNodeHandoff } from "./store-target-normalizers.js";

/** Writes to a node ticket's recorded worktree; a replaced worktree is left alone. */
export class WorkboardNodeWorktreeStore extends WorkboardNotificationStore {
  /** Records the handoff phase on the card's node worktree; a replaced worktree is left alone. */
  async setNodeHandoff(
    id: string,
    input: WorkboardNodeHandoffInput,
    scope?: WorkboardMutationScope,
  ): Promise<WorkboardCard | undefined> {
    return await this.updateNodeWorktree(id, input, scope, withNodeHandoff);
  }

  /** Adds a report's decisions or an import's changes to the worktree's current round. */
  async recordNodeRound(
    id: string,
    input: WorkboardNodeRoundFacts & { worktreePath: string },
    scope?: WorkboardMutationScope,
  ): Promise<WorkboardCard | undefined> {
    return await this.updateNodeWorktree(id, input, scope, withNodeRound);
  }

  private async updateNodeWorktree<T extends { worktreePath: string; summary?: string }>(
    id: string,
    input: T,
    scope: WorkboardMutationScope | undefined,
    update: (worktree: WorkboardNodeWorktree, input: T) => WorkboardNodeWorktree,
  ): Promise<WorkboardCard | undefined> {
    return await this.enqueueMutation(async () => {
      const result = await this.updateLatestCard(
        id,
        (card) => {
          assertCanMutateClaimedCard(card, scope);
          const target = card.metadata?.automation?.target;
          if (!target?.worktree || target.worktree.path !== input.worktreePath) {
            return undefined;
          }
          return {
            metadata: {
              ...card.metadata,
              automation: {
                ...card.metadata?.automation,
                ...(input.summary ? { summary: input.summary } : {}),
                target: { ...target, worktree: update(target.worktree, input) },
              },
            },
          };
        },
        { allowAutomationLaunch: true },
      );
      return result.updated ? result.card : undefined;
    });
  }
}
