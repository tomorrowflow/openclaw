import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  WorkboardCard,
  WorkboardScreenshotListResult,
  WorkboardScreenshotResult,
  WorkboardScreenshotRound,
} from "@openclaw/workboard-contract";
import { COMMIT_ID, hostGit, nodeTicketTarget } from "./node-ticket.js";

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
  let missing = 0;
  for (const { round, changes } of rounds) {
    const paths = await roundImagePaths(target.hostRepoPath, changes.from, changes.to);
    if (!paths) {
      missing += 1;
    } else if (paths.length > 0) {
      listed.push({ round, commit: changes.to, paths });
    }
  }
  if (missing === rounds.length) {
    throw new Error(`no round's commits are left in ${target.hostRepoPath}`);
  }
  return { rounds: listed };
}

/** The round's image paths; undefined when its commits are gone from the host clone. */
async function roundImagePaths(
  repoPath: string,
  from: string,
  to: string,
): Promise<string[] | undefined> {
  if (!COMMIT_ID.test(from) || !COMMIT_ID.test(to)) {
    throw new Error(`round commits ${from}..${to} are not commit ids`);
  }
  const result = await hostGit(repoPath, [
    "diff",
    "--name-only",
    "-z",
    "--no-renames",
    "--diff-filter=AM",
    "--end-of-options",
    from,
    to,
  ]);
  if (result.code !== 0) {
    for (const commit of [from, to]) {
      const verify = await hostGit(repoPath, [
        "rev-parse",
        "--verify",
        "--quiet",
        "--end-of-options",
        `${commit}^{commit}`,
      ]);
      // A quiet exit 1 is a name the repository lacks; the command runner also
      // reports timeouts and spawn failures as 1, but with a message.
      if (verify.code === 1 && !verify.stderr.trim()) {
        return undefined;
      }
    }
    const detail = (result.stderr || result.stdout).trim() || `exit ${result.code}`;
    throw new Error(`host git diff ${from}..${to} failed in ${repoPath}: ${detail}`);
  }
  return result.stdout
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
  const paths =
    target && changes && mimeType
      ? await roundImagePaths(target.hostRepoPath, changes.from, changes.to)
      : undefined;
  if (!target || !changes || !mimeType || !paths?.includes(path)) {
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
