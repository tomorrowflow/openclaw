import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WorkboardCard, WorkboardChangeDiffResult } from "@openclaw/workboard-contract";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { COMMIT_ID, nodeTicketTarget } from "./node-ticket.js";

const execFileAsync = promisify(execFile);

// A diff renders as text in the card drawer; past this the operator opens it on GitHub.
const MAX_DIFF_CHARS = 200_000;
const MAX_DIFF_BYTES = MAX_DIFF_CHARS * 4;
const DIFF_TIMEOUT_MS = 30_000;

function isOutputCapError(error: unknown): error is { stdout: string } {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" &&
    "stdout" in error &&
    typeof error.stdout === "string"
  );
}

/**
 * One file's diff in one node ticket round, read from the host clone, which
 * holds every imported round. Only files the round's import recorded can be
 * read; a rename diffs from its recorded previous path.
 */
export async function readNodeTicketChangeDiff(
  card: WorkboardCard,
  round: number,
  path: string,
): Promise<WorkboardChangeDiffResult> {
  const target = nodeTicketTarget(card);
  const changes = target?.worktree?.rounds?.find((entry) => entry.round === round)?.changes;
  const file = changes?.files.find((entry) => entry.path === path);
  if (!target || !changes || !file) {
    throw new Error(`changed file not found: round ${round} ${path}`);
  }
  if (!COMMIT_ID.test(changes.from) || !COMMIT_ID.test(changes.to)) {
    throw new Error(`round commits ${changes.from}..${changes.to} are not commit ids`);
  }
  // The SDK command runner keeps the tail of long output; a diff must keep its head.
  let diff: string;
  let capped = false;
  try {
    ({ stdout: diff } = await execFileAsync(
      "git",
      [
        "-C",
        target.hostRepoPath,
        "--literal-pathspecs",
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "-M",
        "--end-of-options",
        changes.from,
        changes.to,
        "--",
        ...(file.previousPath ? [file.previousPath] : []),
        path,
      ],
      { encoding: "utf8", maxBuffer: MAX_DIFF_BYTES, timeout: DIFF_TIMEOUT_MS },
    ));
  } catch (error) {
    if (!isOutputCapError(error)) {
      const detail = error instanceof Error && "stderr" in error ? String(error.stderr).trim() : "";
      throw new Error(
        `host git diff ${changes.from}..${changes.to} failed in ${target.hostRepoPath}: ${detail || String(error)}`,
        { cause: error },
      );
    }
    diff = error.stdout;
    capped = true;
  }
  return diff.length <= MAX_DIFF_CHARS && !capped
    ? { diff, truncated: false }
    : { diff: truncateUtf16Safe(diff, MAX_DIFF_CHARS), truncated: true };
}
