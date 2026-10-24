import type {
  WorkboardCard,
  WorkboardNodeVerification,
  WorkboardNodeWorktree,
} from "@openclaw/workboard-contract";
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

  /** Records the current round's verification, replacing the previous record. */
  async setNodeVerification(
    id: string,
    input: { worktreePath: string; verification: WorkboardNodeVerification },
  ): Promise<WorkboardCard | undefined> {
    return await this.updateNodeWorktree(id, input, undefined, (worktree, { verification }) => ({
      ...worktree,
      verification,
    }));
  }

  /**
   * The operator's re-run: drops a finished verification of a ticket waiting
   * in review on its imported round, so the handoff pass starts a fresh one.
   * The way back from an `error` verdict.
   */
  async dropNodeVerification(id: string): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const result = await this.updateLatestCard(
        id,
        (card) => {
          const target = card.metadata?.automation?.target;
          const worktree = target?.worktree;
          if (
            !target ||
            !worktree ||
            worktree.handoff?.phase !== "imported" ||
            card.status !== "review" ||
            card.metadata?.archivedAt
          ) {
            throw new Error(
              "only a node ticket waiting in review on an imported round can be verified again.",
            );
          }
          if (worktree.verification?.phase !== "done") {
            throw new Error(
              worktree.verification
                ? "the verification is still running; wait for its comment."
                : "this round has no finished verification to re-run; the handoff pass starts one when the board has a verifier.",
            );
          }
          const { verification: _dropped, ...rest } = worktree;
          return {
            metadata: {
              ...card.metadata,
              automation: { ...card.metadata?.automation, target: { ...target, worktree: rest } },
            },
          };
        },
        { allowAutomationLaunch: true },
      );
      return result.card;
    });
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
