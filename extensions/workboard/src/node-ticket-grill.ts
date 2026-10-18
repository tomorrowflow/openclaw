import type { WorkboardMetadata } from "@openclaw/workboard-contract";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { MAX_ATTACHMENT_BYTES } from "./store-constants.js";

/** The card attachment that records a node ticket's grilling, question by question. */
export const GRILL_LOG_FILE_NAME = "grilling.md";
export const GRILL_LOG_MIME_TYPE = "text/markdown";
// The card comment announces the question; the Grilling tab holds its full text.
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
 * it is, so a long grilling never fails the report or answer it records.
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

function grillAnswerHeading(answeredAt: number): string {
  return `**Answer** (${new Date(answeredAt).toISOString()})\n\n`;
}

export function grillAnswerEntry(answer: string, answeredAt: number): string {
  return `${grillAnswerHeading(answeredAt)}${answer}`;
}

/** The heading every operator end starts with; its entry ends the log until the next question. */
const OPERATOR_END_PREFIX = "## Outcome\n\n**ended by the operator** (";
const NO_CLOSING_NOTE = "no note";

function grillOperatorEndHeading(endedAt: number): string {
  return `${OPERATOR_END_PREFIX}${new Date(endedAt).toISOString()}): `;
}

/**
 * The answer logged at `answeredAt`. It is the log's last entry until the
 * round it resumes reports, except for the operator end a move to done
 * appends after it, so the rest of the log up to that end is the answer.
 */
export function grillAnswerFromLog(log: string, answeredAt: number): string | undefined {
  const heading = grillAnswerHeading(answeredAt);
  const at = log.lastIndexOf(heading);
  if (at < 0) {
    return undefined;
  }
  const rest = log.slice(at + heading.length);
  const end = rest.lastIndexOf(OPERATOR_END_PREFIX);
  return (end < 0 ? rest : rest.slice(0, end)).trim() || undefined;
}

export function grillOutcomeEntry(outcome: string, summary: string): string {
  return `## Outcome\n\n**${outcome}:** ${summary || "no summary given"}`;
}

export function grillOperatorEndEntry(note: string, endedAt: number): string {
  return `${grillOperatorEndHeading(endedAt)}${note || NO_CLOSING_NOTE}`;
}

/**
 * The closing note of the operator end logged at `endedAt`: "" when they left
 * none, undefined when that entry is not in the log. It is the log's last
 * entry until the grilling's next question, so the rest of the log is the note.
 */
export function grillClosingNoteFromLog(log: string, endedAt: number): string | undefined {
  const heading = grillOperatorEndHeading(endedAt);
  const at = log.lastIndexOf(heading);
  if (at < 0) {
    return undefined;
  }
  const note = log.slice(at + heading.length).trim();
  return note === NO_CLOSING_NOTE ? "" : note;
}

/** The card comment that says a grilling question waits: its first line, and where to answer. */
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
  return `**Grilling question ${round}:** ${shown}\n\nAnswer it in the card's Grilling tab; the same session continues with your answer.`;
}
