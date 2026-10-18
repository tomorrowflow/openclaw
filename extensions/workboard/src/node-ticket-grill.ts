import type {
  WorkboardCard,
  WorkboardMetadata,
  WorkboardNodeWorktree,
} from "@openclaw/workboard-contract";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { lastTurnText, parseNodeTicketReport } from "./node-ticket-report.js";
import { cardRunId } from "./store-card-helpers.js";
import { MAX_ATTACHMENT_BYTES } from "./store-constants.js";
import type { WorkboardStore } from "./store.js";

/** The card attachment that records a node ticket's grilling, question by question. */
export const GRILL_LOG_FILE_NAME = "grilling.md";
export const GRILL_LOG_MIME_TYPE = "text/markdown";
// The card comment announces the question; the grilling log holds its full text.
const GRILL_COMMENT_QUESTION_CHARS = 300;
const GRILL_LOG_FULL_NOTE =
  "(The grilling log reached its size limit, so this entry is cut. The full text is in the ticket session.)";

/** The attachment id of the card's grilling log, which trims and deletes must keep. */
export function grillLogAttachmentId(metadata: WorkboardMetadata | undefined): string | undefined {
  return metadata?.automation?.target?.worktree?.grill?.attachmentId;
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Appends one entry to the grilling log. An entry that would push the log past
 * the attachment limit is cut with a note saying so, and a full log stays as
 * it is, so a long grilling never fails the report or chat turn it records.
 */
export function appendGrillLog(
  log: string,
  entry: string,
  maxBytes = MAX_ATTACHMENT_BYTES,
): string {
  const separator = log ? "\n" : "";
  const next = `${log}${separator}${entry}\n`;
  if (utf8Bytes(next) <= maxBytes) {
    return next;
  }
  const room = maxBytes - utf8Bytes(`${log}${separator}\n\n${GRILL_LOG_FULL_NOTE}\n`);
  // A cut inside a multi-byte character decodes to U+FFFD, which is dropped.
  const kept =
    room > 0
      ? Buffer.from(entry, "utf8").subarray(0, room).toString("utf8").replace(/�+$/, "")
      : "";
  return kept.trim() ? `${log}${separator}${kept.trimEnd()}\n\n${GRILL_LOG_FULL_NOTE}\n` : log;
}

export function grillQuestionEntry(round: number, question: string, settled: string): string {
  return [
    `## Question ${round}`,
    "",
    ...(settled ? [`**Settled so far:** ${settled}`, ""] : []),
    question,
  ].join("\n");
}

// One chat message in the log; the full text stays in the session transcript.
const GRILL_CHAT_ENTRY_CHARS = 8000;

/** One message of the grilling chat in the card's session, cut to a bounded length. */
export function grillChatEntry(speaker: "Operator" | "Agent", text: string, at: number): string {
  const shown =
    text.length > GRILL_CHAT_ENTRY_CHARS
      ? `${truncateUtf16Safe(text, GRILL_CHAT_ENTRY_CHARS)}… (cut; the full message is in the session chat)`
      : text;
  return `**${speaker}** (${new Date(at).toISOString()})\n\n${shown || "(no text)"}`;
}

export function grillOutcomeEntry(outcome: string, summary: string): string {
  return `## Outcome\n\n**${outcome}:** ${summary || "no summary given"}`;
}

/** Who or what ended the grilling, as its outcome entry names it. */
export type GrillEndedBy =
  | "ended by the operator"
  | "settled in the session chat"
  | `ended by a ${"done" | "blocked" | "needs_input"} reply in the session chat`;

/** Every grilling end starts its entry so; it ends the log until the next question. */
const END_PREFIX = "## Outcome\n\n**";
const NO_CLOSING_NOTE = "no note";

function endStamp(endedAt: number): string {
  return `** (${new Date(endedAt).toISOString()}): `;
}

export function grillEndEntry(by: GrillEndedBy, note: string, endedAt: number): string {
  return `${END_PREFIX}${by}${endStamp(endedAt)}${note || NO_CLOSING_NOTE}`;
}

/**
 * The closing note of the grilling end logged at `endedAt`: "" when it has
 * none, undefined when that entry is not in the log. It is the log's last
 * entry until the grilling's next question, so the rest of the log is the note.
 */
export function grillClosingNoteFromLog(log: string, endedAt: number): string | undefined {
  const stamp = endStamp(endedAt);
  const entry = log.lastIndexOf(END_PREFIX);
  const at = entry < 0 ? -1 : log.indexOf(stamp, entry + END_PREFIX.length);
  if (at < 0) {
    return undefined;
  }
  const note = log.slice(at + stamp.length).trim();
  return note === NO_CLOSING_NOTE ? "" : note;
}

/** The card comment that announces a grilling question: its first line, and where to answer. */
export function grillQuestionComment(round: number, question: string): string {
  const firstLine =
    question
      .split("\n")
      .find((line) => line.trim())
      ?.trim() ?? "";
  const shown =
    firstLine.length > GRILL_COMMENT_QUESTION_CHARS
      ? `${truncateUtf16Safe(firstLine, GRILL_COMMENT_QUESTION_CHARS - 1)}…`
      : firstLine;
  return `**Grilling question ${round}:** ${shown}\n\nAnswer it in the card's session chat; the grilling continues there until it ends.`;
}

/**
 * The grilling is live in the card's session chat: the card waits in review
 * on an open grill that nothing has ended yet. A move to done ends it only
 * once no chat turn is replying, so it stays live in done until then.
 */
export function nodeGrillIsLive(card: WorkboardCard, worktree: WorkboardNodeWorktree): boolean {
  return (
    (card.status === "review" || card.status === "done") &&
    !card.metadata?.archivedAt &&
    worktree.handoff?.phase === "grilling" &&
    worktree.grill?.status === "open" &&
    !worktree.grill.pending
  );
}

/** A turn that ended on the card's session: its run id and, when known, when it started. */
type EndedTurn = { startedAt?: number; runId?: string };

/**
 * A turn on the card's session belongs to the live grilling when it started
 * after the round that asked the first question ended. Turns of that round
 * and of earlier ones started before. An `agent_end` without `durationMs`
 * gives no start; then a run other than the card's linked one, the round
 * that asked, is a chat turn, since no round runs while the grilling is live.
 */
export function nodeGrillTakesChatTurn(
  card: WorkboardCard,
  worktree: WorkboardNodeWorktree,
  turn: EndedTurn,
): boolean {
  if (!nodeGrillIsLive(card, worktree) || worktree.handoff?.phase !== "grilling") {
    return false;
  }
  return turn.startedAt !== undefined
    ? turn.startedAt >= worktree.handoff.askedAt
    : turn.runId !== undefined && turn.runId !== cardRunId(card);
}

const CHAT_TURN_UNSETTLED =
  "The reply failed before it settled; a retry may follow in the session chat.";

/**
 * Takes a turn that ended on a card's session when it is a chat turn of the
 * live grilling; the card stays in review and wakes no automation. Every
 * such turn is logged: a plain reply, one asking its next question with a
 * grill report, one whose report block cannot be read (the card says so, so
 * the operator can tell the agent), and one that failed before it settled.
 * Any other report ends the grilling, so work is never imported outside a
 * claimed round: the session resumes to carry out the ticket. A write that
 * fails is warned about, never thrown out of the turn's end.
 */
export async function takeNodeGrillChatTurn(
  store: WorkboardStore,
  turn: EndedTurn & { card: WorkboardCard; messages: readonly unknown[] },
  settled: boolean,
  warn?: (message: string) => void,
): Promise<boolean> {
  const { card } = turn;
  const worktree = card.metadata?.automation?.target?.worktree;
  if (!worktree || !nodeGrillTakesChatTurn(card, worktree, turn)) {
    return false;
  }
  const chat = {
    worktreePath: worktree.path,
    ...(turn.startedAt === undefined ? {} : { startedAt: turn.startedAt }),
    ...(turn.runId === undefined ? {} : { runId: turn.runId }),
    ...lastTurnText(turn.messages),
  };
  const parsed = settled ? parseNodeTicketReport(turn.messages) : undefined;
  const report = parsed?.ok ? parsed.report : undefined;
  try {
    if (!report || report.outcome === "grill") {
      await store.recordNodeGrillChatTurn(card.id, {
        ...chat,
        ...(report ? { question: { text: report.question, summary: report.summary } } : {}),
        ...(!parsed
          ? { note: CHAT_TURN_UNSETTLED }
          : !parsed.ok && !parsed.missing
            ? { unreadable: parsed.reason }
            : {}),
      });
    } else {
      await store.endNodeGrillFromChat(card.id, {
        ...chat,
        outcome: report.outcome,
        summary: report.outcome === "done" ? (report.headline ?? report.summary) : report.summary,
      });
    }
  } catch (error) {
    warn?.(
      `workboard could not record a grilling chat turn on card ${card.id}: ${formatErrorMessage(error)}`,
    );
  }
  return true;
}
