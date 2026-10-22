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
  grillEndEntry,
  type GrillEndedBy,
  grillHandoffEntry,
  grillOutcomeEntry,
  grillSessionName,
  nodeGrillIsLive,
} from "./node-ticket-grill.js";
import { cutReportText } from "./node-ticket-report.js";
import { appendComment, assertCanMutateClaimedCard } from "./store-card-helpers.js";
import { WorkboardCardConflictError } from "./store-core.js";
import type { WorkboardMutationScope } from "./store-inputs.js";
import { WorkboardNodeTicketSampleStore } from "./store-node-ticket-sample.js";

const NOT_GRILLING = "This card is not grilling; refresh it to see where it stands.";
const NOT_ASKING =
  "This card does not wait on a questions round; refresh it to see where it stands.";
const QUESTIONS_PREFIX = "**Needs input:**";
// The result a resumed round's brief carries; the full text is in the grill session.
const MAX_RESULT_CHARS = 8000;

/** One write to a node ticket's grilling: the log entries, if any, and the state it leaves. */
type GrillStep = {
  entries?: string[];
  grill: Omit<WorkboardNodeGrill, "attachmentId">;
  handoff?: WorkboardNodeHandoff;
  comment?: string;
  status?: "todo";
};

/**
 * Ends the grilling: the log gets its result, the grill closes, and the card
 * moves to todo, which resumes the ticket session through the grilling reopen
 * with the end pending for its brief. A full log cuts the result, never
 * refuses the end.
 */
function endGrillStep(
  grill: WorkboardNodeGrill,
  by: GrillEndedBy,
  result: string,
  now: number,
): GrillStep {
  return {
    entries: [grillEndEntry(by, cutReportText(result, MAX_RESULT_CHARS), now)],
    grill: {
      status: "closed",
      rounds: grill.rounds,
      ...(grill.sessionKey ? { sessionKey: grill.sessionKey } : {}),
      pending: { kind: "end", at: now },
    },
    status: "todo",
  };
}

/**
 * The handoff Grill this writes from a questions round: the round's comments
 * and every comment after them, which may already answer some questions.
 */
function questionsHandoff(card: WorkboardCard): string | undefined {
  const comments = card.metadata?.comments ?? [];
  const at = comments.findLastIndex((comment) => comment.body.startsWith(QUESTIONS_PREFIX));
  if (at < 0) {
    return undefined;
  }
  return [
    "The ticket session stopped with open questions, and the operator chose to grill them out instead of answering by comment. Its questions round, with its proposed defaults, and any comments since:",
    "",
    comments
      .slice(at)
      .map((comment) => comment.body.trim())
      .join("\n\n---\n\n"),
    "",
    "Start with the question the others depend on, and settle every question in the round.",
  ].join("\n");
}

/** Session keys compare as the Gateway canonicalizes them. */
function sameSessionKey(left: string | undefined, right: string | undefined): boolean {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

type GrillPlan = (
  card: WorkboardCard,
  worktree: WorkboardNodeWorktree,
  now: number,
) => GrillStep | undefined;

export class WorkboardNodeTicketGrillStore extends WorkboardNodeTicketSampleStore {
  /**
   * A grill report: logs its handoff, opens the grill or counts its next
   * round, and waits in the grilling handoff until the grill session for
   * this round is created and recorded.
   */
  async recordNodeGrillHandoff(
    id: string,
    input: { worktreePath: string; handoff: string },
    scope?: WorkboardMutationScope,
  ): Promise<WorkboardCard | undefined> {
    return await this.updateNodeGrill(id, scope, (_card, worktree, now) => {
      if (worktree.path !== input.worktreePath) {
        return undefined;
      }
      const rounds = (worktree.grill?.rounds ?? 0) + 1;
      return {
        entries: [grillHandoffEntry(rounds, input.handoff)],
        grill: { status: "open", rounds },
        handoff: { phase: "grilling", askedAt: now },
      };
    });
  }

  /**
   * The operator's Grill this: a card waiting on a questions round hands the
   * round to a grill session instead of a comment, as a grill report would.
   */
  async grillNodeQuestions(id: string): Promise<WorkboardCard> {
    const card = await this.updateNodeGrill(id, undefined, (current, worktree, now) => {
      const handoff = questionsHandoff(current);
      if (
        current.status !== "review" ||
        current.metadata?.archivedAt ||
        worktree.handoff?.phase !== "questions" ||
        !handoff
      ) {
        throw new Error(NOT_ASKING);
      }
      const rounds = (worktree.grill?.rounds ?? 0) + 1;
      return {
        entries: [grillHandoffEntry(rounds, handoff)],
        grill: { status: "open", rounds },
        handoff: { phase: "grilling", askedAt: now },
      };
    });
    if (!card) {
      throw new Error(NOT_ASKING);
    }
    return card;
  }

  /** Records the grill session created for grilling `round`, and says on the card where it runs. */
  async setNodeGrillSession(
    id: string,
    input: { worktreePath: string; round: number; sessionKey: string },
  ): Promise<WorkboardCard | undefined> {
    return await this.updateNodeGrill(id, undefined, (card, worktree) => {
      const grill = worktree.grill;
      if (
        worktree.path !== input.worktreePath ||
        !grill ||
        grill.rounds !== input.round ||
        grill.sessionKey ||
        !nodeGrillIsLive(card, worktree)
      ) {
        return undefined;
      }
      return {
        grill: { status: grill.status, rounds: grill.rounds, sessionKey: input.sessionKey },
        comment: `**Grilling ${grill.rounds}** runs in its own session, ${grillSessionName(card)} (\`${input.sessionKey}\`). Open it from the card's Grilling tab; the result comes back here when the grilling ends.`,
      };
    });
  }

  /**
   * The grill session hands its result back. Only the session recorded for
   * the live grilling may; the card's id narrows the search when given.
   */
  async settleNodeGrill(input: {
    cardId?: string;
    sessionKey: string | undefined;
    result: string;
  }): Promise<WorkboardCard> {
    const owned = (card: WorkboardCard) => {
      const worktree = card.metadata?.automation?.target?.worktree;
      return Boolean(
        worktree &&
        nodeGrillIsLive(card, worktree) &&
        sameSessionKey(worktree.grill?.sessionKey, input.sessionKey),
      );
    };
    const candidates = input.cardId ? [await this.requireCard(input.cardId)] : await this.list();
    const card = candidates.find(owned);
    if (!card) {
      throw new Error(
        "No grilling runs in this session: only the grill session Workboard created for a card's live grilling can hand its result back.",
      );
    }
    const settled = await this.updateNodeGrill(card.id, undefined, (current, worktree, now) =>
      owned(current) && worktree.grill
        ? endGrillStep(worktree.grill, "settled in the grill session", input.result, now)
        : undefined,
    );
    if (!settled) {
      throw new Error(NOT_GRILLING);
    }
    return settled;
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
      const { pending, attachmentId: _attachmentId, ...kept } = grill;
      if (grill.status === "open") {
        return {
          entries: [grillOutcomeEntry(input.outcome, input.summary)],
          grill: { ...kept, status: "closed" },
        };
      }
      return pending ? { grill: kept } : undefined;
    });
  }

  /** The operator's End grilling, with the grill session's last reply as its result. */
  async endNodeGrill(id: string, result: string): Promise<WorkboardCard> {
    const card = await this.updateNodeGrill(id, undefined, (current, worktree, now) => {
      if (!nodeGrillIsLive(current, worktree) || !worktree.grill) {
        throw new Error(NOT_GRILLING);
      }
      return endGrillStep(worktree.grill, "ended by the operator", result, now);
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
    input: { worktreePath: string; result: string },
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
        : endGrillStep(grill, "ended by the operator", input.result, now);
    });
  }

  /** The card's grilling log; undefined without a grill or when the log is gone. */
  async readNodeGrillLog(worktree: WorkboardNodeWorktree): Promise<string | undefined> {
    if (!worktree.grill) {
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
