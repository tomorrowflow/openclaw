// Stream-json output limits and raw-line framing for the CLI streaming parser.
// Kept beside `cli-output-stream.ts` so the parser stays within the file-size
// budget; the limits are process constants, not per-backend configuration.
import type { CliStreamJsonOutputLimits } from "./cli-output-contracts.js";

const CLI_STREAM_JSON_DEFAULT_BUDGET_CHARS = 8 * 1024 * 1024;
export const CLI_STREAM_JSON_OUTPUT_LIMITS = Object.freeze({
  maxTurnRetainedChars: CLI_STREAM_JSON_DEFAULT_BUDGET_CHARS,
  maxPendingLineChars: CLI_STREAM_JSON_DEFAULT_BUDGET_CHARS,
} satisfies CliStreamJsonOutputLimits);

// Every retained append also keeps a string piece or map entry behind the
// payload, so a flood of one-character appends costs memory the payload length
// alone would not show. The fixed share bounds such floods at 8 MiB / 33 appends.
export const CLI_STREAM_JSON_RETAINED_APPEND_OVERHEAD = 32;

/** Charges for state that lives until the owner releases it as one unit. */
export type RetainedOutputScope = {
  retain(chars: number): void;
  release(): void;
};

/** Live gauge of what the parser currently holds; trips once it exceeds the budget. */
export type RetainedOutputLedger = {
  /** Charges state that lives for the rest of the turn. */
  retain(chars: number): void;
  /** Refunds one earlier `retain(chars)` whose state was freed. */
  release(chars: number): void;
  /** Opens a lifetime whose charges are refunded together when its state is freed. */
  scope(): RetainedOutputScope;
};

export function createRetainedOutputLedger(
  maxRetainedChars: number,
  onExceeded: () => void,
): RetainedOutputLedger {
  let retainedChars = 0;
  const charge = (amount: number) => {
    retainedChars += amount;
    if (retainedChars > maxRetainedChars) {
      onExceeded();
    }
  };
  return {
    retain: (chars) => charge(chars + CLI_STREAM_JSON_RETAINED_APPEND_OVERHEAD),
    release: (chars) => {
      retainedChars -= chars + CLI_STREAM_JSON_RETAINED_APPEND_OVERHEAD;
    },
    scope: () => {
      let charged = 0;
      return {
        retain: (chars) => {
          const amount = chars + CLI_STREAM_JSON_RETAINED_APPEND_OVERHEAD;
          charged += amount;
          charge(amount);
        },
        release: () => {
          retainedChars -= charged;
          charged = 0;
        },
      };
    },
  };
}

/** Frames arbitrary stdout chunks while bounding each individual raw JSONL line. */
export function frameBoundedCliJsonlChunk(
  state: { pending: string },
  chunk: string,
  maxLineChars: number,
  onLine: (line: string) => boolean | void,
): boolean {
  for (let offset = 0; offset < chunk.length;) {
    const newlineIndex = chunk.indexOf("\n", offset);
    const lineEnd = newlineIndex === -1 ? chunk.length : newlineIndex;
    if (state.pending.length + (lineEnd - offset) > maxLineChars) {
      state.pending = "";
      return false;
    }
    state.pending += chunk.slice(offset, lineEnd);
    if (newlineIndex === -1) {
      return true;
    }
    const line = state.pending;
    // Control-response writes can synchronously reenter stdout framing.
    state.pending = "";
    offset = newlineIndex + 1;
    if (onLine(line) === false) {
      return true;
    }
  }
  return true;
}

const STREAM_JSON_OUTPUT_LIMIT_CONSEQUENCE =
  "the CLI was stopped and its final reply was lost. Work the CLI already did (files, commits) may exist; check it before re-running.";

export function streamJsonOutputLimitErrorText(kind: "retained" | "line", limit: number): string {
  if (kind === "line") {
    return `CLI JSONL line exceeded ${limit} characters; ${STREAM_JSON_OUTPUT_LIMIT_CONSEQUENCE}`;
  }
  return `CLI turn retained output exceeded the ${limit}-character Gateway parse budget; ${STREAM_JSON_OUTPUT_LIMIT_CONSEQUENCE}`;
}
