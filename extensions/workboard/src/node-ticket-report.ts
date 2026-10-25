import type { WorkboardNodeDecision, WorkboardNodeReview } from "@openclaw/workboard-contract";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  MAX_REVIEW_NOTE_CHARS,
  normalizeNodeDecisions,
  normalizeNodeFindings,
  normalizeNodeReview,
} from "./node-ticket-rounds.js";
import { MAX_PROOF_COMMAND_CHARS, MAX_PROOF_NOTE_CHARS } from "./store-constants.js";
import { capText } from "./store-normalizers.js";

/** The fence of the report block that ends a node ticket session's final message. */
export const REPORT_FENCE = "workboard-report";
// The headline replaces the card summary shown on the board: a few sentences, not a report.
const MAX_REPORT_HEADLINE_CHARS = 400;
const REPORT_PATTERN = new RegExp("```" + REPORT_FENCE + "\\s*\\n([\\s\\S]*?)\\n```", "g");

// One report posts at most this many comments, so a run-on report cannot evict
// the card's other comments from its metadata budget.
const MAX_REPORT_COMMENTS = 3;
// Report comments stay well under the operator note cap for the same budget reason.
const MAX_REPORT_COMMENT_CHARS = 2000;

const REPORT_PROOF_STATUSES = ["passed", "failed", "skipped"] as const;

type NodeTicketProof = {
  command?: string;
  status: (typeof REPORT_PROOF_STATUSES)[number];
  note?: string;
};

export type NodeTicketStopReport = {
  outcome: "blocked" | "needs_input";
  summary: string;
  questions: string[];
  decisions: WorkboardNodeDecision[];
};

/** A handoff of the grilling to a new session: what was researched and settled, and the first question. */
type NodeTicketGrillReport = {
  outcome: "grill";
  handoff: string;
  decisions: WorkboardNodeDecision[];
};

export type NodeTicketReport =
  | NodeTicketGrillReport
  | {
      outcome: "done";
      headline?: string;
      summary: string;
      proof: NodeTicketProof[];
      review?: WorkboardNodeReview;
      decisions: WorkboardNodeDecision[];
    }
  | NodeTicketStopReport;

function messageText(message: Record<string, unknown>): string | undefined {
  if (typeof message.content === "string") {
    return message.content;
  }
  if (Array.isArray(message.content)) {
    return message.content
      .flatMap((part) => (isRecord(part) && typeof part.text === "string" ? [part.text] : []))
      .join("\n");
  }
  return undefined;
}

function lastAssistantText(messages: readonly unknown[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isRecord(message) && message.role === "assistant") {
      const text = messageText(message);
      if (text !== undefined) {
        return text;
      }
    }
  }
  return undefined;
}

/** The text of the last assistant message that has any, such as a session's last reply in its history. */
export function lastAssistantReply(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const text = isRecord(message) && message.role === "assistant" ? messageText(message) : "";
    if (text?.trim()) {
      return text.trim();
    }
  }
  return "";
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function cutMarker(dropped: number): string {
  return `(cut, ${dropped} chars dropped; the full report is in the ticket session's final message)`;
}

/** Report fields are session output: bounds one to the store limit it lands in, and says so. */
export function cutReportText(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const kept = truncateUtf16Safe(text, Math.max(0, max - cutMarker(text.length).length - 1));
  return `${kept} ${cutMarker(text.length - kept.length)}`;
}

/**
 * Splits report text into card comments of at most `max` chars, at line breaks
 * and inside a line too long for one comment, so no text is lost to one
 * comment's limit. Past the report's comment budget the rest is cut with a
 * marker; the footer always ends the last comment.
 */
export function reportComments(
  text: string,
  { footer, max = MAX_REPORT_COMMENT_CHARS }: { footer?: string; max?: number } = {},
): string[] {
  const tail = footer ? `\n\n${footer}` : "";
  const room = max - tail.length - cutMarker(text.length).length - 2;
  const lines = text.split("\n");
  const bodies: string[] = [];
  let dropped = "";
  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index] ?? "";
    const last = bodies.at(-1);
    if (last !== undefined && last.length + 1 + line.length <= room) {
      bodies[bodies.length - 1] = `${last}\n${line}`;
      continue;
    }
    while (line.trim() && bodies.length < MAX_REPORT_COMMENTS) {
      const chunk = truncateUtf16Safe(line, room);
      bodies.push(chunk);
      line = line.slice(chunk.length).trimStart();
    }
    if (line.trim()) {
      dropped = [line, ...lines.slice(index + 1)].join("\n").trim();
      break;
    }
  }
  const ending = [...(dropped ? [cutMarker(dropped.length)] : []), ...(footer ? [footer] : [])];
  const trimmed = bodies.map((body) => body.trimEnd()).filter(Boolean);
  if (ending.length === 0) {
    return trimmed;
  }
  return [...trimmed.slice(0, -1), [...trimmed.slice(-1), ...ending].join("\n\n")];
}

/** The rung b standards review; its counts cover every valid finding, before the items cap. */
function parseReview(value: unknown): WorkboardNodeReview | undefined {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    // A session resumed under a brief from before itemized findings still reports counts only.
    return normalizeNodeReview(value);
  }
  const items = normalizeNodeFindings(value.items);
  // A review whose items were all malformed must not read as a clean one.
  const dropped = value.items.length - items.length;
  const droppedNote =
    dropped > 0 ? `(${dropped} malformed finding${dropped === 1 ? "" : "s"} dropped)` : "";
  const note = capText(optionalText(value.note), MAX_REVIEW_NOTE_CHARS - droppedNote.length - 1);
  return normalizeNodeReview({
    note: [note, droppedNote].filter(Boolean).join(" "),
    findings: items.length,
    fixed: items.filter((item) => item.fixed).length,
    items,
  });
}

// Sessions close the one-line report with a stray `}` after `decisions` and repeat it when resumed
// with the parser's position, so up to two trailing braces are dropped. Only an object counts then,
// so a cut-off or wrong-shaped block still fails.
const MAX_STRAY_BRACES = 2;

function parseReportJson(
  block: string,
): { ok: true; value: unknown } | { ok: false; error: unknown } {
  try {
    return { ok: true, value: JSON.parse(block) };
  } catch (error) {
    let trimmed = block.trimEnd();
    for (let stray = 0; stray < MAX_STRAY_BRACES && trimmed.endsWith("}"); stray += 1) {
      trimmed = trimmed.slice(0, -1).trimEnd();
      try {
        const value: unknown = JSON.parse(trimmed);
        if (isRecord(value)) {
          return { ok: true, value };
        }
      } catch {
        // The next trailing brace may be stray too.
      }
    }
    return { ok: false, error };
  }
}

/** Reads the last report block of the final assistant message; anything else is a contract miss. */
export function parseNodeTicketReport(
  messages: readonly unknown[],
): { ok: true; report: NodeTicketReport } | { ok: false; reason: string; missing?: true } {
  const text = lastAssistantText(messages);
  const block = text ? [...text.matchAll(REPORT_PATTERN)].at(-1)?.[1] : undefined;
  if (!block) {
    return {
      ok: false,
      reason: "The ticket session ended without a workboard-report block.",
      missing: true,
    };
  }
  const parsed = parseReportJson(block);
  if (!parsed.ok) {
    // The parser's position is what lets the resumed session fix its own block.
    return {
      ok: false,
      reason: `The ticket session's workboard-report block is not valid JSON: ${formatErrorMessage(parsed.error)}.`,
    };
  }
  const value = parsed.value;
  if (!isRecord(value)) {
    return { ok: false, reason: "The ticket session's workboard-report block is not an object." };
  }
  const summary = optionalText(value.summary) ?? "";
  const decisions = normalizeNodeDecisions(value.decisions);
  if (value.outcome === "done") {
    const proof = (Array.isArray(value.proof) ? value.proof : []).flatMap(
      (entry): NodeTicketProof[] => {
        const status = isRecord(entry)
          ? REPORT_PROOF_STATUSES.find((candidate) => candidate === entry.status)
          : undefined;
        if (!isRecord(entry) || !status) {
          return [];
        }
        const command = optionalText(entry.command);
        const note = optionalText(entry.note);
        return [
          {
            status,
            ...(command ? { command: cutReportText(command, MAX_PROOF_COMMAND_CHARS) } : {}),
            ...(note ? { note: cutReportText(note, MAX_PROOF_NOTE_CHARS) } : {}),
          },
        ];
      },
    );
    const review = parseReview(value.review);
    const headline = capText(optionalText(value.headline), MAX_REPORT_HEADLINE_CHARS);
    return {
      ok: true,
      report: {
        outcome: "done",
        ...(headline ? { headline } : {}),
        summary,
        proof,
        ...(review ? { review } : {}),
        decisions,
      },
    };
  }
  if (value.outcome === "grill") {
    if (!summary) {
      return {
        ok: false,
        reason: "The ticket session's grill report has no handoff in `summary`.",
      };
    }
    return { ok: true, report: { outcome: "grill", handoff: summary, decisions } };
  }
  if (value.outcome === "blocked" || value.outcome === "needs_input") {
    const questions = (Array.isArray(value.questions) ? value.questions : []).flatMap((entry) => {
      const question = optionalText(entry);
      return question ? [question] : [];
    });
    return { ok: true, report: { outcome: value.outcome, summary, questions, decisions } };
  }
  return { ok: false, reason: "The ticket session's workboard-report has an unknown outcome." };
}
