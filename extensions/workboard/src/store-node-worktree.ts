import type {
  WorkboardCard,
  WorkboardNodeVerification,
  WorkboardNodeWorktree,
  WorkboardPullRequestState,
  WorkboardVisualVerdict,
} from "@openclaw/workboard-contract";
import {
  visualCheckComment,
  visualCheckNote,
  type WorkboardNodeRoundFacts,
  withNodeRound,
} from "./node-ticket-rounds.js";
import { type VerificationSlot, visualCheckVerification } from "./review-readiness.js";
import { appendComment, assertCanMutateClaimedCard } from "./store-card-helpers.js";
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

  /**
   * Records the GitHub state of the published handoff's PR. Writes only a
   * changed state of the same PR on the same worktree, so a sync that finds
   * nothing new leaves the card's `updatedAt` alone.
   */
  async recordPullRequestState(
    id: string,
    input: {
      worktreePath: string;
      pullRequestUrl: string;
      state: WorkboardPullRequestState;
      checkedAt: number;
    },
  ): Promise<WorkboardCard | undefined> {
    return await this.enqueueMutation(async () => {
      const result = await this.updateLatestCard(
        id,
        (card) => {
          const target = card.metadata?.automation?.target;
          const worktree = target?.worktree;
          const handoff = worktree?.handoff;
          if (
            !target ||
            worktree?.path !== input.worktreePath ||
            handoff?.phase !== "published" ||
            handoff.pullRequestUrl !== input.pullRequestUrl ||
            handoff.pullRequest?.state === input.state
          ) {
            return undefined;
          }
          const pullRequest = { state: input.state, checkedAt: input.checkedAt };
          return {
            metadata: {
              ...card.metadata,
              automation: {
                ...card.metadata?.automation,
                target: {
                  ...target,
                  worktree: { ...worktree, handoff: { ...handoff, pullRequest } },
                },
              },
            },
          };
        },
        { allowAutomationLaunch: true },
      );
      return result.updated ? result.card : undefined;
    });
  }

  /**
   * Reopens a done ticket whose open PR conflicts with its base for a rework
   * round that merges the base; the comment is that round's review feedback.
   * Once per publish: a card an operator already moved, or a publish already
   * reopened, is left alone.
   */
  async reopenConflictingPullRequest(
    id: string,
    input: { worktreePath: string; pullRequestUrl: string; now: number },
  ): Promise<WorkboardCard | undefined> {
    return await this.enqueueMutation(async () => {
      const result = await this.updateLatestCard(
        id,
        (card) => {
          const target = card.metadata?.automation?.target;
          const worktree = target?.worktree;
          const handoff = worktree?.handoff;
          if (
            card.status !== "done" ||
            card.metadata?.archivedAt ||
            !target ||
            worktree?.path !== input.worktreePath ||
            handoff?.phase !== "published" ||
            handoff.pullRequestUrl !== input.pullRequestUrl ||
            handoff.conflictReworkAt !== undefined
          ) {
            return undefined;
          }
          return {
            status: "todo",
            metadata: {
              ...card.metadata,
              comments: appendComment(
                card.metadata?.comments,
                `The draft PR ${input.pullRequestUrl} no longer merges into its base branch. Merge the base branch into the PR branch as a new merge commit, resolve the conflicts keeping both sides' intent, and re-run the ticket's proof on the merged result.`,
                input.now,
              ),
              automation: {
                ...card.metadata?.automation,
                target: {
                  ...target,
                  worktree: {
                    ...worktree,
                    handoff: { ...handoff, conflictReworkAt: input.now },
                  },
                },
              },
            },
          };
        },
        { allowAutomationLaunch: true },
      );
      return result.updated ? result.card : undefined;
    });
  }

  /** Adds a report's decisions or an import's changes to the worktree's current round. */
  async recordNodeRound(
    id: string,
    input: WorkboardNodeRoundFacts & { worktreePath: string },
    scope?: WorkboardMutationScope,
  ): Promise<WorkboardCard | undefined> {
    return await this.updateNodeWorktree(id, input, scope, withNodeRound);
  }

  /** Records the current round's verification in its slot, replacing the previous record. */
  async setNodeVerification(
    id: string,
    input: {
      worktreePath: string;
      slot?: VerificationSlot;
      verification: WorkboardNodeVerification;
    },
  ): Promise<WorkboardCard | undefined> {
    return await this.updateNodeWorktree(
      id,
      input,
      undefined,
      (worktree, { slot = "verification", verification }) => ({
        ...worktree,
        [slot]: verification,
      }),
    );
  }

  /**
   * The operator's re-run: drops a finished verification of a ticket waiting
   * in review on its imported round, and its cross-verification, so the
   * handoff pass starts both afresh. The way back from an `error` verdict.
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
          if (
            worktree.verification?.phase !== "done" ||
            worktree.crossVerification?.phase === "running"
          ) {
            throw new Error(
              worktree.verification
                ? "the verification is still running; wait for its comment."
                : "this round has no finished verification to re-run; the handoff pass starts one when the board has a verifier.",
            );
          }
          const { verification: _dropped, crossVerification: _droppedCross, ...rest } = worktree;
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

  /**
   * Recording the check reveals the verifier's visual read on card reads
   * (`redactCard`); the comment pairing the two has no agent source, so it
   * is never taken for the verifier's own comment.
   */
  async setNodeVisualCheck(
    id: string,
    input: { verdict: WorkboardVisualVerdict; note?: string },
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const result = await this.updateLatestCard(
        id,
        (card) => {
          const verification = visualCheckVerification(card);
          const target = card.metadata?.automation?.target;
          const worktree = target?.worktree;
          if (!verification || !target || !worktree) {
            throw new Error(
              worktree?.handoff?.phase === "imported" && !card.metadata?.archivedAt
                ? "this round's verification has not finished; record the visual check after the verifier's comment."
                : "only a node ticket waiting on an imported round can get a visual check.",
            );
          }
          if (verification.visualCheck) {
            throw new Error(
              "this verification already has a visual check; re-run the verification (workboard.cards.verify) to record a new one.",
            );
          }
          const note = visualCheckNote(input.note);
          const visualCheck = { verdict: input.verdict, ...(note ? { note } : {}), at: Date.now() };
          return {
            metadata: {
              ...card.metadata,
              comments: appendComment(
                card.metadata?.comments,
                visualCheckComment(verification.visual, visualCheck),
                visualCheck.at,
                "operator",
              ),
              automation: {
                ...card.metadata?.automation,
                target: {
                  ...target,
                  worktree: { ...worktree, verification: { ...verification, visualCheck } },
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
