import type {
  WorkboardCard,
  WorkboardMetadata,
  WorkboardNodeWorktree,
} from "@openclaw/workboard-contract";
import { MAX_ATTACHMENT_BYTES } from "./store-constants.js";

/** The card attachment that records a node ticket's grilling: each handoff and its result. */
export const GRILL_LOG_FILE_NAME = "grilling.md";
export const GRILL_LOG_MIME_TYPE = "text/markdown";
const GRILL_LOG_FULL_NOTE =
  "(The grilling log reached its size limit, so this entry is cut. The full text is in the session.)";

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
 * it is, so a long grilling never fails the write it records.
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

function handoffHeading(round: number): string {
  return `## Handoff ${round}\n\n`;
}

export function grillHandoffEntry(round: number, handoff: string): string {
  return `${handoffHeading(round)}${handoff}`;
}

/**
 * The handoff of grilling `round`. Until its grill session exists nothing
 * else is logged after it, so the rest of the log is the handoff.
 */
export function grillHandoffFromLog(log: string, round: number): string | undefined {
  const at = log.lastIndexOf(handoffHeading(round));
  const handoff = at < 0 ? "" : log.slice(at + handoffHeading(round).length).trim();
  return handoff || undefined;
}

export function grillOutcomeEntry(outcome: string, summary: string): string {
  return `## Outcome\n\n**${outcome}:** ${summary || "no summary given"}`;
}

/** Who ended the grilling, as its result entry names it. */
export type GrillEndedBy = "settled in the grill session" | "ended by the operator";

/** Every grilling end starts its entry so; it ends the log until the next handoff. */
const END_PREFIX = "## Result\n\n**";
const NO_RESULT = "No result was handed back.";

function endStamp(endedAt: number): string {
  return `** (${new Date(endedAt).toISOString()})\n\n`;
}

export function grillEndEntry(by: GrillEndedBy, result: string, endedAt: number): string {
  return `${END_PREFIX}${by}${endStamp(endedAt)}${result || NO_RESULT}`;
}

/**
 * The grilling end logged at `endedAt`: who ended it and its result, "" when
 * it has none; undefined when that entry is not in the log. It is the log's
 * last entry until the grilling's next handoff, so the rest of the log is the
 * result.
 */
export function grillEndFromLog(
  log: string,
  endedAt: number,
): { by: GrillEndedBy; result: string } | undefined {
  const stamp = endStamp(endedAt);
  const entry = log.lastIndexOf(END_PREFIX);
  const at = entry < 0 ? -1 : log.indexOf(stamp, entry + END_PREFIX.length);
  if (at < 0) {
    return undefined;
  }
  const by: GrillEndedBy =
    log.slice(entry + END_PREFIX.length, at) === "ended by the operator"
      ? "ended by the operator"
      : "settled in the grill session";
  const result = log.slice(at + stamp.length).trim();
  return { by, result: result === NO_RESULT ? "" : result };
}

/**
 * The grilling is live in its grill session: the card waits in review on an
 * open grill that nothing has ended yet. A move to done ends it only once the
 * grill session is not replying, so it stays live in done until then.
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

/** The grill session's name in the session list and on the card. */
export function grillSessionName(card: WorkboardCard): string {
  return `Grill ${card.title}`;
}
