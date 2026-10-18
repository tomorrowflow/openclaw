import { execFile } from "node:child_process";
import { posix } from "node:path";
import { promisify } from "node:util";
import type {
  WorkboardCard,
  WorkboardCommittedScreenshots,
  WorkboardLiveScreenshot,
  WorkboardLiveScreenshots,
  WorkboardScreenshotListResult,
  WorkboardScreenshotResult,
  WorkboardScreenshotRound,
  WorkboardScreenshotSource,
} from "@openclaw/workboard-contract";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { fetchNodeFile, isPathSegment, listNodeDir } from "./node-files.js";
import {
  COMMIT_ID,
  hostGit,
  nodeTicketTarget,
  type WorkboardNodeTicketRuntime,
} from "./node-ticket.js";

const execFileAsync = promisify(execFile);

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};
const MAX_LISTED_SCREENSHOTS = 120;
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;
const READ_TIMEOUT_MS = 30_000;
const DEFAULT_SCREENSHOT_DIRS = ["docs/screenshots"];
// Evidence nests a run dir under its screenshot dir: features/evidence/ios-<run>/x.png.
const LIVE_MAX_DEPTH = 2;
const LIVE_MAX_LISTINGS = 40;
const LIVE_LIST_ENTRIES = 500;

function imageType(path: string): string | undefined {
  const extension = /\.([a-z]+)$/i.exec(path)?.[1]?.toLowerCase();
  return extension ? IMAGE_TYPES[extension] : undefined;
}

/**
 * A node ticket's screenshots: images its rounds committed, for example under
 * `docs/screenshots/<ID>/`, and images the running agent has written into its
 * node worktree so far. The host clone holds every imported round, so those
 * are listed and read from git rather than copied into card state.
 */
export async function listNodeTicketScreenshots(
  runtime: WorkboardNodeTicketRuntime,
  card: WorkboardCard,
  now: () => number = Date.now,
): Promise<WorkboardScreenshotListResult> {
  const [committed, live] = await Promise.all([listCommitted(card), listLive(runtime, card, now)]);
  return { committed, live };
}

async function listCommitted(card: WorkboardCard): Promise<WorkboardCommittedScreenshots> {
  const target = nodeTicketTarget(card);
  const rounds = (target?.worktree?.rounds ?? []).flatMap((entry) =>
    entry.changes ? [{ round: entry.round, changes: entry.changes }] : [],
  );
  if (!target?.hostRepoPath || rounds.length === 0) {
    return { state: "available", rounds: [] };
  }
  const listed: WorkboardScreenshotRound[] = [];
  let missing = 0;
  try {
    for (const { round, changes } of rounds) {
      const paths = await roundImagePaths(target.hostRepoPath, changes.from, changes.to);
      if (!paths) {
        missing += 1;
      } else if (paths.length > 0) {
        listed.push({ round, commit: changes.to, paths });
      }
    }
  } catch (error) {
    return { state: "unavailable", reason: formatErrorMessage(error) };
  }
  if (missing === rounds.length) {
    return {
      state: "unavailable",
      reason: `no round's commits are left in ${target.hostRepoPath}`,
    };
  }
  return { state: "available", rounds: listed };
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
    .slice(0, MAX_LISTED_SCREENSHOTS);
}

/** One listed screenshot's bytes; paths the source did not list are refused. */
export async function readNodeTicketScreenshot(
  runtime: WorkboardNodeTicketRuntime,
  card: WorkboardCard,
  source: WorkboardScreenshotSource,
  path: string,
): Promise<WorkboardScreenshotResult> {
  return "live" in source
    ? readLiveScreenshot(runtime, card, path)
    : readRoundScreenshot(card, source.round, path);
}

async function readRoundScreenshot(
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

/** Where the agent writes screenshots; undefined once its round was imported and the worktree removed. */
function liveWorktree(card: WorkboardCard) {
  const target = nodeTicketTarget(card);
  const worktree = target?.worktree;
  const phase = worktree?.handoff?.phase;
  if (!target || !worktree || phase === "imported" || phase === "published") {
    return undefined;
  }
  return {
    nodeId: target.nodeId,
    root: worktree.path,
    dirs: target.screenshotDirs ?? DEFAULT_SCREENSHOT_DIRS,
  };
}

function liveUnavailableReason(nodeId: string, root: string, error: unknown): string {
  return `${formatErrorMessage(error)}. Check that node ${nodeId} is connected, that gateway.nodes.commands.allow includes dir.list and file.fetch, and that its file-transfer allowReadPaths cover the screenshot dirs under ${root}.`;
}

async function listLive(
  runtime: WorkboardNodeTicketRuntime,
  card: WorkboardCard,
  now: () => number,
): Promise<WorkboardLiveScreenshots> {
  const worktree = liveWorktree(card);
  if (!worktree) {
    return { state: "none" };
  }
  const { nodeId, root, dirs } = worktree;
  const shots: WorkboardLiveScreenshot[] = [];
  const pending = dirs.map((dir) => ({ dir, depth: 0 }));
  try {
    for (let listings = 0; listings < LIVE_MAX_LISTINGS; listings += 1) {
      const next = pending.shift();
      if (!next) {
        break;
      }
      for (const entry of await listNodeDir(
        runtime,
        nodeId,
        posix.join(root, next.dir),
        LIVE_LIST_ENTRIES,
      )) {
        const relative = `${next.dir}/${entry.name}`;
        if (entry.isDir && next.depth < LIVE_MAX_DEPTH) {
          pending.push({ dir: relative, depth: next.depth + 1 });
        } else if (entry.isFile && imageType(entry.name)) {
          shots.push({ path: relative, bytes: entry.size, mtimeMs: entry.mtime });
        }
      }
    }
  } catch (error) {
    return { state: "unavailable", reason: liveUnavailableReason(nodeId, root, error) };
  }
  return {
    state: "available",
    listedAt: now(),
    shots: shots
      .toSorted(
        (left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path),
      )
      .slice(0, MAX_LISTED_SCREENSHOTS),
  };
}

/** A live path must be an image inside one of the target's screenshot dirs, at most as deep as the listing walks. */
function isLiveScreenshotPath(dirs: readonly string[], path: string): boolean {
  return dirs.some((dir) => {
    if (!path.startsWith(`${dir}/`)) {
      return false;
    }
    const rest = path.slice(dir.length + 1).split("/");
    return rest.length <= LIVE_MAX_DEPTH + 1 && rest.every(isPathSegment);
  });
}

async function readLiveScreenshot(
  runtime: WorkboardNodeTicketRuntime,
  card: WorkboardCard,
  path: string,
): Promise<WorkboardScreenshotResult> {
  const worktree = liveWorktree(card);
  const mimeType = imageType(path);
  if (!worktree || !mimeType || !isLiveScreenshotPath(worktree.dirs, path)) {
    throw new Error(`screenshot not found: live ${path}`);
  }
  const bytes = await fetchNodeFile(
    runtime,
    worktree.nodeId,
    posix.join(worktree.root, path),
    MAX_SCREENSHOT_BYTES,
  );
  return { mimeType, contentBase64: bytes.toString("base64") };
}
