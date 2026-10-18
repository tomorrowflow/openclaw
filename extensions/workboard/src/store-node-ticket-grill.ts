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
  grillOperatorEndEntry,
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
  "The grilling log is full, so this answer cannot be recorded. End the grilling instead; the session continues the ticket with what is settled.";

/** One write to a node ticket's grilling: the log entry, if any, and the state it leaves. */
type GrillStep = {
  entry?: string;
  /** The error that refuses the write when the log has no room for the whole entry. */
  cutError?: string;
  grill: Omit<WorkboardNodeGrill, "attachmentId">;
  handoff?: WorkboardNodeHandoff;
  comment?: string;
  status?: "todo";
};

/** A grilling question waits on the operator, who has not answered or ended it yet. */
function waitsOnOperator(worktree: WorkboardNodeWorktree): boolean {
  return (
    worktree.handoff?.phase === "grilling" &&
    worktree.grill?.status === "open" &&
    !worktree.grill.pending
  );
}

/**
 * The operator ends the grilling: the log gets its outcome, the grill closes,
 * and the card moves to todo, which resumes the session through the grilling
 * reopen with the end pending for its brief. An answer still pending stays
 * pending, so the brief carries it before the end. A full log cuts the note,
 * never refuses the end.
 */
function endGrillStep(worktree: WorkboardNodeWorktree, note: string, now: number): GrillStep {
  const pending = worktree.grill?.pending;
  return {
    entry: grillOperatorEndEntry(note, now),
    grill: {
      status: "closed",
      rounds: worktree.grill?.rounds ?? 1,
      pending: pending?.kind === "answer" ? pending : { kind: "end", at: now },
    },
    status: "todo",
  };
}

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

  /**
   * A done, blocked, or needs_input report ends an open grill with its
   * outcome in the log. After the operator ended the grill, the report only
   * clears the end its round consumed.
   */
  async closeNodeGrill(
    id: string,
    input: { worktreePath: string; outcome: string; summary: string },
    scope?: WorkboardMutationScope,
  ): Promise<WorkboardCard | undefined> {
    return await this.updateNodeGrill(id, scope, (_card, worktree) => {
      const grill = worktree.grill;
      if (worktree.path !== input.worktreePath || !grill) {
        return undefined;
      }
      if (grill.status === "open") {
        return {
          entry: grillOutcomeEntry(input.outcome, input.summary),
          grill: { status: "closed", rounds: grill.rounds },
        };
      }
      return grill.pending ? { grill: { status: "closed", rounds: grill.rounds } } : undefined;
    });
  }

  /** The operator's End grilling, with an optional closing note for the next round. */
  async endNodeGrill(id: string, note: unknown): Promise<WorkboardCard> {
    const text = normalizeBoundedString(note, undefined, MAX_GRILL_ANSWER_CHARS, "note") ?? "";
    const card = await this.updateNodeGrill(id, undefined, (current, worktree, now) => {
      if (current.status !== "review" || !waitsOnOperator(worktree)) {
        throw new Error(NOT_WAITING);
      }
      return endGrillStep(worktree, text, now);
    });
    if (!card) {
      throw new Error(NOT_WAITING);
    }
    return card;
  }

  /**
   * A grilling ticket the operator moved to done has nothing to publish yet,
   * so the move ends the grilling without a note, as End grilling does, and
   * the card goes back to todo to resume the session. A grill already ended
   * keeps what is pending and only goes back to todo.
   */
  async endNodeGrillMovedToDone(
    id: string,
    input: { worktreePath: string },
  ): Promise<WorkboardCard | undefined> {
    return await this.updateNodeGrill(id, undefined, (card, worktree, now) => {
      const grill = worktree.grill;
      if (
        card.status !== "done" ||
        card.metadata?.archivedAt ||
        worktree.path !== input.worktreePath ||
        worktree.handoff?.phase !== "grilling" ||
        !grill
      ) {
        return undefined;
      }
      return grill.status === "closed" && grill.pending
        ? { grill, status: "todo" }
        : endGrillStep(worktree, "", now);
    });
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
      if (current.status !== "review" || !grill || !waitsOnOperator(worktree)) {
        throw new Error(NOT_WAITING);
      }
      return {
        entry: grillAnswerEntry(text, now),
        cutError: LOG_FULL,
        grill: { ...grill, pending: { kind: "answer", at: now } },
        status: "todo",
      };
    });
    if (!card) {
      throw new Error(NOT_WAITING);
    }
    return card;
  }

  /**
   * The grilling log a round's brief reads the pending answer or closing note
   * from; undefined when nothing is pending or the log is gone.
   */
  async readNodeGrillLog(worktree: WorkboardNodeWorktree): Promise<string | undefined> {
    if (!worktree.grill?.pending) {
      return undefined;
    }
    const stored = await this.attachmentStore.lookup(worktree.grill.attachmentId);
    return stored ? Buffer.from(stored.contentBase64, "base64").toString("utf8") : undefined;
  }

  /**
   * Writes the log blob, then the card that points at it, in the mutation
   * queue. A refused card write puts the previous log back. A step without an
   * entry leaves the log as it is.
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
      const written =
        step.entry === undefined
          ? undefined
          : await this.writeGrillLog(card, logged, step.entry, step.cutError, now);
      const attachment = written?.attachment ?? logged;
      if (!attachment) {
        return undefined;
      }
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
        await written?.restore();
        throw error;
      }
    });
  }

  /** Appends an entry to the card's log blob; `restore` puts the previous log back. */
  private async writeGrillLog(
    card: WorkboardCard,
    logged: WorkboardAttachment | undefined,
    entry: string,
    cutError: string | undefined,
    now: number,
  ): Promise<{ attachment: WorkboardAttachment; restore: () => Promise<void> }> {
    const previous = logged ? await this.attachmentStore.lookup(logged.id) : undefined;
    const log = appendGrillLog(
      previous ? Buffer.from(previous.contentBase64, "base64").toString("utf8") : "",
      entry,
    );
    if (cutError && !log.endsWith(`${entry}\n`)) {
      throw new Error(cutError);
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
    return {
      attachment,
      restore: async () => {
        await (previous
          ? this.attachmentStore.register(attachment.id, previous)
          : this.attachmentStore.delete(attachment.id));
      },
    };
  }
}
