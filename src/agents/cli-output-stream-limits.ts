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
  "the CLI was stopped and its report was lost. Work it completed on the node or worktree may exist; check it before re-running.";

export function streamJsonOutputLimitErrorText(kind: "retained" | "line", limit: number): string {
  if (kind === "line") {
    return `CLI JSONL line exceeded ${limit} characters; ${STREAM_JSON_OUTPUT_LIMIT_CONSEQUENCE}`;
  }
  return `CLI turn retained output exceeded the ${limit}-character Gateway parse budget; ${STREAM_JSON_OUTPUT_LIMIT_CONSEQUENCE}`;
}
