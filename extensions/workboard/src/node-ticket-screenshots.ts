import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  WorkboardCard,
  WorkboardScreenshotListResult,
  WorkboardScreenshotResult,
  WorkboardScreenshotRound,
} from "@openclaw/workboard-contract";
import { hostGit, nodeTicketTarget, requireHostGit } from "./node-ticket.js";

const execFileAsync = promisify(execFile);

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};
const MAX_ROUND_SCREENSHOTS = 120;
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;
const READ_TIMEOUT_MS = 30_000;

function imageType(path: string): string | undefined {
  const extension = /\.([a-z]+)$/i.exec(path)?.[1]?.toLowerCase();
  return extension ? IMAGE_TYPES[extension] : undefined;
}

/**
 * A node ticket's screenshots are images its rounds committed, for example
 * under `docs/screenshots/<ID>/`. The host clone holds every imported round,
 * so they are listed and read from git rather than copied into card state.
 */
export async function listNodeTicketScreenshots(
  card: WorkboardCard,
): Promise<WorkboardScreenshotListResult> {
  const target = nodeTicketTarget(card);
  const rounds = (target?.worktree?.rounds ?? []).flatMap((entry) =>
    entry.changes ? [{ round: entry.round, changes: entry.changes }] : [],
  );
  if (!target?.hostRepoPath || rounds.length === 0) {
    return { rounds: [] };
  }
  const listed: WorkboardScreenshotRound[] = [];
  for (const { round, changes } of rounds) {
    const paths = await roundImagePaths(target.hostRepoPath, changes.from, changes.to);
    if (paths.length > 0) {
      listed.push({ round, commit: changes.to, paths });
    }
  }
  return { rounds: listed };
}

async function roundImagePaths(repoPath: string, from: string, to: string): Promise<string[]> {
  const output = await requireHostGit(repoPath, [
    "diff",
    "--name-only",
    "-z",
    "--diff-filter=AMR",
    from,
    to,
  ]);
  return output
    .split("\0")
    .filter((path) => path && imageType(path))
    .toSorted()
    .slice(0, MAX_ROUND_SCREENSHOTS);
}

/** One listed screenshot's bytes; paths a round did not list are refused. */
export async function readNodeTicketScreenshot(
  card: WorkboardCard,
  round: number,
  path: string,
): Promise<WorkboardScreenshotResult> {
  const target = nodeTicketTarget(card);
  const changes = target?.worktree?.rounds?.find((entry) => entry.round === round)?.changes;
  const mimeType = imageType(path);
  if (
    !target ||
    !changes ||
    !mimeType ||
    !(await roundImagePaths(target.hostRepoPath, changes.from, changes.to)).includes(path)
  ) {
    throw new Error(`screenshot not found: round ${round} ${path}`);
  }
  const repoPath = target.hostRepoPath;
  const object = `${changes.to}:${path}`;
  const size = await hostGit(repoPath, ["cat-file", "-s", object]);
  const bytes = Number(size.stdout.trim());
  if (size.code !== 0 || !Number.isInteger(bytes)) {
    throw new Error(`screenshot ${path} is no longer in ${repoPath}`);
  }
  if (bytes > MAX_SCREENSHOT_BYTES) {
    throw new Error(
      `screenshot ${path} is ${bytes} bytes, over the ${MAX_SCREENSHOT_BYTES}-byte limit`,
    );
  }
  // The SDK command runner decodes stdout as text, which corrupts image bytes.
  const { stdout } = await execFileAsync("git", ["-C", repoPath, "cat-file", "blob", object], {
    encoding: "buffer",
    maxBuffer: MAX_SCREENSHOT_BYTES + 1,
    timeout: READ_TIMEOUT_MS,
  });
  return { mimeType, contentBase64: stdout.toString("base64") };
}
