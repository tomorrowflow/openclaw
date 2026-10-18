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
  grillChatEntry,
  grillEndEntry,
  type GrillEndedBy,
  grillOutcomeEntry,
  grillQuestionComment,
  grillQuestionEntry,
  nodeGrillIsLive,
  nodeGrillTakesChatTurn,
} from "./node-ticket-grill.js";
import { cutReportText } from "./node-ticket-report.js";
import { appendComment, assertCanMutateClaimedCard } from "./store-card-helpers.js";
import { WorkboardCardConflictError } from "./store-core.js";
import type { WorkboardMutationScope } from "./store-inputs.js";
import { WorkboardNodeTicketSampleStore } from "./store-node-ticket-sample.js";

const NOT_GRILLING = "This card is not grilling; refresh it to see where it stands.";
// The closing note a resumed round's brief carries; the full text is in the session.
const MAX_CLOSING_NOTE_CHARS = 4000;

/** One write to a node ticket's grilling: the log entries, if any, and the state it leaves. */
type GrillStep = {
  entries?: string[];
  grill: Omit<WorkboardNodeGrill, "attachmentId">;
  handoff?: WorkboardNodeHandoff;
  comment?: string;
  status?: "todo";
};

/**
 * One chat turn in the card's session: what the operator sent and what the
 * agent replied. A turn without its start is dated when it ended.
 */
type GrillChatTurn = {
  worktreePath: string;
  startedAt?: number;
  runId?: string;
  prompt: string;
  reply: string;
};

function chatTurnIsLive(card: WorkboardCard, worktree: WorkboardNodeWorktree, turn: GrillChatTurn) {
  return worktree.path === turn.worktreePath && nodeGrillTakesChatTurn(card, worktree, turn);
}

function chatTurnEntries(turn: GrillChatTurn, now: number, note?: string): string[] {
  return [
    grillChatEntry("Operator", turn.prompt, turn.startedAt ?? now),
    grillChatEntry("Agent", note ? `${turn.reply}\n\n${note}`.trim() : turn.reply, now),
  ];
}

function unreadableReportComment(reason: string): string {
  return `The agent's last reply in the session chat ended with a report the board could not read, so the grilling goes on: ${reason} Tell the agent in the session chat.`;
}

/**
 * Ends the grilling: the log gets its outcome, the grill closes, and the card
 * moves to todo, which resumes the session through the grilling reopen with
 * the end pending for its brief. A full log cuts the note, never refuses the end.
 */
function endGrillStep(
  worktree: WorkboardNodeWorktree,
  by: GrillEndedBy,
  note: string,
  now: number,
  before: string[] = [],
): GrillStep {
  return {
    entries: [...before, grillEndEntry(by, cutReportText(note, MAX_CLOSING_NOTE_CHARS), now)],
    grill: {
      status: "closed",
      rounds: worktree.grill?.rounds ?? 1,
      pending: { kind: "end", at: now },
    },
    status: "todo",
  };
}

type GrillPlan = (
  card: WorkboardCard,
  worktree: WorkboardNodeWorktree,
  now: number,
) => GrillStep | undefined;

export class WorkboardNodeTicketGrillStore extends WorkboardNodeTicketSampleStore {
  /**
   * A grill report: logs the question, opens the grill or counts its next
   * round, posts the question's card comment, and waits in the grilling
   * handoff, where the operator chats with the session.
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
        entries: [grillQuestionEntry(rounds, input.question, input.summary)],
        grill: { status: "open", rounds },
        handoff: { phase: "grilling", askedAt: now },
        comment: grillQuestionComment(rounds, input.question),
      };
    });
  }

  /**
   * A chat turn of the live grilling: the operator's message and the agent's
   * reply go to the log, and the card keeps waiting in review. A reply that
   * asks its next question with a grill report logs it as the next round.
   */
  async recordNodeGrillChatTurn(
    id: string,
    turn: GrillChatTurn & {
      question?: { text: string; summary: string };
      /** Why the reply's report block could not be read; the card says so too. */
      unreadable?: string;
      /** A line the agent's entry ends with, such as a failed reply's. */
      note?: string;
    },
  ): Promise<WorkboardCard | undefined> {
    return await this.updateNodeGrill(id, undefined, (card, worktree, now) => {
      const grill = worktree.grill;
      if (!grill || !chatTurnIsLive(card, worktree, turn)) {
        return undefined;
      }
      const rounds = grill.rounds + (turn.question ? 1 : 0);
      const note = turn.unreadable
        ? `The reply's report could not be read: ${turn.unreadable}`
        : turn.note;
      return {
        entries: [
          ...chatTurnEntries(turn, now, note),
          ...(turn.question
            ? [grillQuestionEntry(rounds, turn.question.text, turn.question.summary)]
            : []),
        ],
        grill: { status: "open", rounds },
        ...(turn.unreadable ? { comment: unreadableReportComment(turn.unreadable) } : {}),
      };
    });
  }

  /**
   * A chat turn whose reply ended the live grilling with any other report:
   * the turn and the end go to the log, and the session resumes as after End
   * grilling, with the report's summary as the closing note. Nothing the
   * reply reported is imported; the resumed round reports for the ticket.
   */
  async endNodeGrillFromChat(
    id: string,
    turn: GrillChatTurn & {
      outcome: "grill_done" | "done" | "blocked" | "needs_input";
      summary: string;
    },
  ): Promise<WorkboardCard | undefined> {
    return await this.updateNodeGrill(id, undefined, (card, worktree, now) => {
      if (!chatTurnIsLive(card, worktree, turn)) {
        return undefined;
      }
      const by: GrillEndedBy =
        turn.outcome === "grill_done"
          ? "settled in the session chat"
          : `ended by a ${turn.outcome} reply in the session chat`;
      return endGrillStep(worktree, by, turn.summary, now, chatTurnEntries(turn, now));
    });
  }

  /**
   * A done, blocked, or needs_input report ends an open grill with its
   * outcome in the log. After the grill ended, the report only clears the
   * end its round consumed.
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
          entries: [grillOutcomeEntry(input.outcome, input.summary)],
          grill: { status: "closed", rounds: grill.rounds },
        };
      }
      return grill.pending ? { grill: { status: "closed", rounds: grill.rounds } } : undefined;
    });
  }

  /** The operator's End grilling. */
  async endNodeGrill(id: string): Promise<WorkboardCard> {
    const card = await this.updateNodeGrill(id, undefined, (current, worktree, now) => {
      if (!nodeGrillIsLive(current, worktree)) {
        throw new Error(NOT_GRILLING);
      }
      return endGrillStep(worktree, "ended by the operator", "", now);
    });
    if (!card) {
      throw new Error(NOT_GRILLING);
    }
    return card;
  }

  /**
   * A grilling ticket the operator moved to done has nothing to publish yet,
   * so the move ends the grilling, as End grilling does, and the card goes
   * back to todo to resume the session. A grill already ended keeps what is
   * pending and only goes back to todo.
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
        : endGrillStep(worktree, "ended by the operator", "", now);
    });
  }

  /**
   * The grilling log a round's brief reads the closing note from; undefined
   * when nothing is pending or the log is gone.
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
   * queue. A refused card write puts the previous log back; a conflict plans
   * the step once more on the newer card. A step without entries leaves the
   * log as it is.
   */
  private async updateNodeGrill(
    id: string,
    scope: WorkboardMutationScope | undefined,
    plan: GrillPlan,
  ): Promise<WorkboardCard | undefined> {
    return await this.enqueueMutation(async () => {
      try {
        return await this.writeNodeGrill(id, scope, plan);
      } catch (error) {
        if (!(error instanceof WorkboardCardConflictError)) {
          throw error;
        }
        return await this.writeNodeGrill(id, scope, plan);
      }
    });
  }

  private async writeNodeGrill(
    id: string,
    scope: WorkboardMutationScope | undefined,
    plan: GrillPlan,
  ): Promise<WorkboardCard | undefined> {
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
    const written = step.entries?.length
      ? await this.writeGrillLog(card, logged, step.entries, now)
      : undefined;
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
  }

  /** Appends entries to the card's log blob; `restore` puts the previous log back. */
  private async writeGrillLog(
    card: WorkboardCard,
    logged: WorkboardAttachment | undefined,
    entries: readonly string[],
    now: number,
  ): Promise<{ attachment: WorkboardAttachment; restore: () => Promise<void> }> {
    const previous = logged ? await this.attachmentStore.lookup(logged.id) : undefined;
    const log = entries.reduce(
      (current, entry) => appendGrillLog(current, entry),
      previous ? Buffer.from(previous.contentBase64, "base64").toString("utf8") : "",
    );
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
