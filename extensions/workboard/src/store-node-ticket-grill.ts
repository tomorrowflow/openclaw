import { randomUUID } from "node:crypto";
import type {
  WorkboardAttachment,
  WorkboardCard,
  WorkboardNodeGrill,
  WorkboardNodeHandoff,
  WorkboardNodeWorktree,
} from "@openclaw/workboard-contract";
import {
  appendGrillLog,
  GRILL_LOG_FILE_NAME,
  GRILL_LOG_MIME_TYPE,
  grillAnswerEntry,
  grillOutcomeEntry,
  grillQuestionComment,
  grillQuestionEntry,
} from "./node-ticket-grill.js";
import { appendComment, assertCanMutateClaimedCard } from "./store-card-helpers.js";
import { MAX_GRILL_ANSWER_CHARS } from "./store-constants.js";
import type { WorkboardMutationScope } from "./store-inputs.js";
import { WorkboardNodeTicketSampleStore } from "./store-node-ticket-sample.js";
import { normalizeBoundedString } from "./store-value-normalizers.js";

const NOT_WAITING =
  "This card is not waiting on a grilling answer; refresh it to see where it stands.";
const LOG_FULL =
  "The grilling log is full, so this answer cannot be recorded. Move the card to done to end the grilling, then comment how to continue.";

/** One write to a node ticket's grilling: the log entry and the state it leaves. */
type GrillStep = {
  entry: string;
  /** The error that refuses the write when the log has no room for the whole entry. */
  cutError?: string;
  grill: Omit<WorkboardNodeGrill, "attachmentId">;
  handoff?: WorkboardNodeHandoff;
  comment?: string;
  status?: "todo" | "review";
};

export class WorkboardNodeTicketGrillStore extends WorkboardNodeTicketSampleStore {
  /**
   * A grill report: logs the question, opens the grill or counts its next
   * round, posts the question's card comment, and waits in the grilling
   * handoff. The answer this round consumed is cleared.
   */
  async recordNodeGrillQuestion(
    id: string,
    input: { worktreePath: string; question: string; summary: string },
    scope?: WorkboardMutationScope,
  ): Promise<WorkboardCard | undefined> {
    return await this.updateNodeGrill(id, scope, (_card, worktree, now) => {
      if (worktree.path !== input.worktreePath) {
        return undefined;
      }
      const rounds = (worktree.grill?.rounds ?? 0) + 1;
      return {
        entry: grillQuestionEntry(rounds, input.question, input.summary),
        grill: { status: "open", rounds },
        handoff: { phase: "grilling", askedAt: now },
        comment: grillQuestionComment(rounds, input.question),
      };
    });
  }

  /** A done, blocked, or needs_input report ends an open grill with its outcome in the log. */
  async closeNodeGrill(
    id: string,
    input: { worktreePath: string; outcome: string; summary: string },
    scope?: WorkboardMutationScope,
  ): Promise<WorkboardCard | undefined> {
    return await this.updateNodeGrill(id, scope, (_card, worktree) =>
      worktree.path === input.worktreePath && worktree.grill?.status === "open"
        ? {
            entry: grillOutcomeEntry(input.outcome, input.summary),
            grill: { status: "closed", rounds: worktree.grill.rounds },
          }
        : undefined,
    );
  }

  /**
   * A ticket the operator moved to done while it waited on a grilling answer:
   * the grilling ends there, and the card goes back to review waiting with
   * open questions, so a comment and a move to todo resume the session. It
   * counts as escalated already; the operator ended it, so `dev` leaves it.
   */
  async endNodeGrillByOperator(id: string, input: { worktreePath: string }): Promise<void> {
    await this.updateNodeGrill(id, undefined, (card, worktree, now) =>
      card.status === "done" &&
      !card.metadata?.archivedAt &&
      worktree.path === input.worktreePath &&
      worktree.handoff?.phase === "grilling" &&
      worktree.grill?.status === "open"
        ? {
            entry: grillOutcomeEntry(
              "ended by the operator",
              "The card was moved to done while it waited on a grilling answer.",
            ),
            grill: { status: "closed", rounds: worktree.grill.rounds },
            handoff: { phase: "questions", askedAt: now, escalatedAt: now },
            comment:
              "Moving this ticket to done ended its grilling, and there is nothing to publish yet. Comment how to continue and move it to todo to resume the session, or archive the card; its node worktree stays until removed by hand.",
            status: "review",
          }
        : undefined,
    );
  }

  /**
   * The operator's answer to the waiting grilling question: logged, kept for
   * the next round's brief, and the card moved to todo, which resumes the
   * session the way a move to todo resumes a questions round.
   */
  async answerNodeGrill(id: string, answer: unknown): Promise<WorkboardCard> {
    const text = normalizeBoundedString(answer, undefined, MAX_GRILL_ANSWER_CHARS, "answer");
    if (!text) {
      throw new Error("answer is required.");
    }
    const card = await this.updateNodeGrill(id, undefined, (current, worktree, now) => {
      const grill = worktree.grill;
      if (
        current.status !== "review" ||
        worktree.handoff?.phase !== "grilling" ||
        grill?.status !== "open" ||
        grill.pendingAnswer
      ) {
        throw new Error(NOT_WAITING);
      }
      return {
        entry: grillAnswerEntry(text, now),
        cutError: LOG_FULL,
        grill: { ...grill, pendingAnswer: { answeredAt: now } },
        status: "todo",
      };
    });
    if (!card) {
      throw new Error(NOT_WAITING);
    }
    return card;
  }

  /**
   * The grilling log a round's brief reads the pending answer from; undefined
   * when no answer is pending or the log is gone.
   */
  async readNodeGrillLog(worktree: WorkboardNodeWorktree): Promise<string | undefined> {
    if (!worktree.grill?.pendingAnswer) {
      return undefined;
    }
    const stored = await this.attachmentStore.lookup(worktree.grill.attachmentId);
    return stored ? Buffer.from(stored.contentBase64, "base64").toString("utf8") : undefined;
  }

  /**
   * Writes the log blob, then the card that points at it, in the mutation
   * queue. A refused card write puts the previous log back.
   */
  private async updateNodeGrill(
    id: string,
    scope: WorkboardMutationScope | undefined,
    plan: (
      card: WorkboardCard,
      worktree: WorkboardNodeWorktree,
      now: number,
    ) => GrillStep | undefined,
  ): Promise<WorkboardCard | undefined> {
    return await this.enqueueMutation(async () => {
      const card = await this.requireCard(id);
      assertCanMutateClaimedCard(card, scope);
      const automation = card.metadata?.automation;
      const target = automation?.target;
      const worktree = target?.worktree;
      const now = Date.now();
      const step = worktree ? plan(card, worktree, now) : undefined;
      if (!target || !worktree || !step) {
        return undefined;
      }
      const attachments = card.metadata?.attachments ?? [];
      const logged = attachments.find((entry) => entry.id === worktree.grill?.attachmentId);
      const previous = logged ? await this.attachmentStore.lookup(logged.id) : undefined;
      const log = appendGrillLog(
        previous ? Buffer.from(previous.contentBase64, "base64").toString("utf8") : "",
        step.entry,
      );
      if (step.cutError && !log.endsWith(`${step.entry}\n`)) {
        throw new Error(step.cutError);
      }
      const content = Buffer.from(log, "utf8");
      const attachment: WorkboardAttachment = {
        id: logged?.id ?? randomUUID(),
        cardId: card.id,
        createdAt: logged?.createdAt ?? now,
        fileName: GRILL_LOG_FILE_NAME,
        mimeType: GRILL_LOG_MIME_TYPE,
        byteSize: content.length,
      };
      await this.attachmentStore.register(attachment.id, {
        version: 1,
        attachment,
        contentBase64: content.toString("base64"),
      });
      try {
        return await this.updateCard(
          card,
          {
            ...(step.status ? { status: step.status } : {}),
            metadata: {
              ...card.metadata,
              comments: appendComment(card.metadata?.comments, step.comment, now),
              attachments: logged
                ? attachments.map((entry) => (entry.id === logged.id ? attachment : entry))
                : [...attachments, attachment],
              automation: {
                ...automation,
                target: {
                  ...target,
                  worktree: {
                    ...worktree,
                    ...(step.handoff ? { handoff: step.handoff } : {}),
                    grill: { ...step.grill, attachmentId: attachment.id },
                  },
                },
              },
            },
          },
          { expectedUpdatedAt: card.updatedAt, allowAutomationLaunch: true },
        );
      } catch (error) {
        await (previous
          ? this.attachmentStore.register(attachment.id, previous)
          : this.attachmentStore.delete(attachment.id));
        throw error;
      }
    });
  }
}
