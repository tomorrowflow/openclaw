import { resolveOptionalIntegerOption } from "openclaw/plugin-sdk/number-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  MAX_BLOCK_REASON_CHARS,
  MAX_COMMENT_BODY_CHARS,
  MAX_PROOF_COMMAND_CHARS,
  MAX_PROOF_NOTE_CHARS,
} from "./store-constants.js";
import { capText } from "./store-normalizers.js";

/** The fence of the report block that ends a node ticket session's final message. */
export const REPORT_FENCE = "workboard-report";
// The headline replaces the card summary shown on the board: a few sentences, not a report.
const MAX_REPORT_HEADLINE_CHARS = 400;
const REPORT_PATTERN = new RegExp("```" + REPORT_FENCE + "\\s*\\n([\\s\\S]*?)\\n```", "g");

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
};

/** The rung b standards review the session ran before its done report. */
type NodeTicketReview = { findings: number; fixed: number; note?: string };

type NodeTicketReport =
  | {
      outcome: "done";
      headline?: string;
      summary: string;
      proof: NodeTicketProof[];
      review?: NodeTicketReview;
    }
  | NodeTicketStopReport;

function lastAssistantText(messages: readonly unknown[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== "assistant") {
      continue;
    }
    if (typeof message.content === "string") {
      return message.content;
    }
    if (Array.isArray(message.content)) {
      return message.content
        .flatMap((part) => (isRecord(part) && typeof part.text === "string" ? [part.text] : []))
        .join("\n");
    }
  }
  return undefined;
}

// Report fields are session output; bound them to the store limits they land in.
function optionalText(value: unknown, max: number): string | undefined {
  return typeof value === "string" ? capText(value.trim(), max) : undefined;
}

function parseReview(value: unknown): NodeTicketReview | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const findings = resolveOptionalIntegerOption(value.findings, { min: 0 });
  const fixed = resolveOptionalIntegerOption(value.fixed, { min: 0 });
  const note = optionalText(value.note, MAX_PROOF_NOTE_CHARS);
  return findings === undefined || fixed === undefined
    ? undefined
    : { findings, fixed, ...(note ? { note } : {}) };
}

/** Reads the last report block of the final assistant message; anything else is a contract miss. */
export function parseNodeTicketReport(
  messages: readonly unknown[],
): { ok: true; report: NodeTicketReport } | { ok: false; reason: string } {
  const text = lastAssistantText(messages);
  const block = text ? [...text.matchAll(REPORT_PATTERN)].at(-1)?.[1] : undefined;
  if (!block) {
    return { ok: false, reason: "The ticket session ended without a workboard-report block." };
  }
  let value: unknown;
  try {
    value = JSON.parse(block);
  } catch {
    return { ok: false, reason: "The ticket session's workboard-report block is not valid JSON." };
  }
  if (!isRecord(value)) {
    return { ok: false, reason: "The ticket session's workboard-report block is not an object." };
  }
  const summary = optionalText(value.summary, MAX_COMMENT_BODY_CHARS) ?? "";
  if (value.outcome === "done") {
    const proof = (Array.isArray(value.proof) ? value.proof : []).flatMap(
      (entry): NodeTicketProof[] => {
        const status = isRecord(entry)
          ? REPORT_PROOF_STATUSES.find((candidate) => candidate === entry.status)
          : undefined;
        if (!isRecord(entry) || !status) {
          return [];
        }
        const command = optionalText(entry.command, MAX_PROOF_COMMAND_CHARS);
        const note = optionalText(entry.note, MAX_PROOF_NOTE_CHARS);
        return [{ status, ...(command ? { command } : {}), ...(note ? { note } : {}) }];
      },
    );
    const review = parseReview(value.review);
    const headline = optionalText(value.headline, MAX_REPORT_HEADLINE_CHARS);
    return {
      ok: true,
      report: {
        outcome: "done",
        ...(headline ? { headline } : {}),
        summary,
        proof,
        ...(review ? { review } : {}),
      },
    };
  }
  if (value.outcome === "blocked" || value.outcome === "needs_input") {
    const questions = (Array.isArray(value.questions) ? value.questions : []).flatMap((entry) => {
      const question = optionalText(entry, MAX_BLOCK_REASON_CHARS);
      return question ? [question] : [];
    });
    return { ok: true, report: { outcome: value.outcome, summary, questions } };
  }
  return { ok: false, reason: "The ticket session's workboard-report has an unknown outcome." };
}
