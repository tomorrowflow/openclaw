import { execFile } from "node:child_process";
import { posix } from "node:path";
import { promisify } from "node:util";
import type {
  WorkboardCard,
  WorkboardCommittedNodeFiles,
  WorkboardExecutionTarget,
  WorkboardLinkedNodeFiles,
  WorkboardLiveNodeFile,
  WorkboardLiveNodeFiles,
  WorkboardNodeFileListResult,
  WorkboardNodeFileRound,
  WorkboardNodeFileSource,
} from "@openclaw/workboard-contract";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { fetchNodeFile, isPathSegment, listNodeDir } from "./node-files.js";
import {
  COMMIT_ID,
  hostGit,
  nodeTicketTarget,
  runNodeCommand,
  type WorkboardNodeTicketRuntime,
} from "./node-ticket.js";

const execFileAsync = promisify(execFile);

type ArtifactKind = {
  /** Names the kind in errors: "screenshot not found". */
  noun: string;
  /** Media type by lowercase extension; other files are not of this kind. */
  types: Readonly<Record<string, string>>;
  maxBytes: number;
  /** Worktree-relative dirs walked live, and the only dirs a live read may name. */
  liveDirs: (target: WorkboardExecutionTarget) => readonly string[];
  /** Committed paths must sit under one of these; undefined accepts any path the round changed. */
  committedDirs?: readonly string[];
};

export type NodeTicketArtifactKind = "screenshot" | "prototype";

const PROTOTYPE_DIRS = ["docs/prototypes"];

const KINDS: Record<NodeTicketArtifactKind, ArtifactKind> = {
  screenshot: {
    noun: "screenshot",
    types: {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
    },
    maxBytes: 8 * 1024 * 1024,
    liveDirs: (target) => target.screenshotDirs ?? ["docs/screenshots"],
  },
  // A repo's own HTML (an app's index.html) is not a prototype, so committed
  // prototypes are bound to the same dir the live walk reads.
  prototype: {
    noun: "prototype",
    types: { html: "text/html", htm: "text/html" },
    maxBytes: 2 * 1024 * 1024,
    liveDirs: () => PROTOTYPE_DIRS,
    committedDirs: PROTOTYPE_DIRS,
  },
};

const MAX_LISTED_FILES = 120;
const READ_TIMEOUT_MS = 30_000;
// Evidence nests a run dir under its screenshot dir: features/evidence/ios-<run>/x.png.
const LIVE_MAX_DEPTH = 2;
const LIVE_MAX_LISTINGS = 40;
const LIVE_LIST_ENTRIES = 500;
const DIR_LIST_TIMEOUT_MS = 20_000;
// One walk may make LIVE_MAX_LISTINGS calls; the deadline bounds the whole walk, not each call.
const LIVE_LIST_DEADLINE_MS = 30_000;

function mediaType(kind: ArtifactKind, path: string): string | undefined {
  const extension = /\.([a-z]+)$/i.exec(path)?.[1]?.toLowerCase();
  return extension ? kind.types[extension] : undefined;
}

function isUnder(dirs: readonly string[], path: string): boolean {
  return dirs.some((dir) => path.startsWith(`${dir}/`));
}

/**
 * Ids of the cards whose files this card shows besides its own: the targets of
 * its outgoing `relates_to` links, in link order. Parent, child, and blocking
 * links schedule work and pull in no content.
 */
export function relatedCardIds(card: WorkboardCard): string[] {
  const ids = (card.metadata?.links ?? []).flatMap((link) =>
    link.type === "relates_to" && link.targetCardId && link.targetCardId !== card.id
      ? [link.targetCardId]
      : [],
  );
  return [...new Set(ids)];
}

/**
 * A node ticket's files of one kind: those its rounds committed, for example
 * under `docs/screenshots/<ID>/` or `docs/prototypes/<ID>/`, and those the
 * running agent has added or changed in its node worktree since the round
 * started. The node worktree is a checkout of the base branch, so the walk
 * keeps only what git reports as changed since the round's start commit.
 * `linked` are the cards `relatedCardIds` names, already resolved by the
 * caller; only their committed rounds are listed. The host clone holds every
 * imported round, so those are listed and read from git rather than copied
 * into card state. The node worktree is walked only when `live` is asked for.
 */
export async function listNodeTicketArtifacts(
  runtime: WorkboardNodeTicketRuntime,
  card: WorkboardCard,
  kindName: NodeTicketArtifactKind,
  options: { live: boolean; linked?: readonly WorkboardCard[]; now?: () => number },
): Promise<WorkboardNodeFileListResult> {
  const kind = KINDS[kindName];
  const [committed, live, linked] = await Promise.all([
    listCommitted(card, kind),
    options.live ? listLive(runtime, card, kind, options.now ?? Date.now) : undefined,
    listLinked(options.linked ?? [], kind),
  ]);
  return {
    committed,
    ...(live ? { live } : {}),
    ...(linked.length > 0 ? { linked } : {}),
  };
}

// A linked card whose host clone cannot list is left out rather than reported: the
// card's own committed listing names a host clone problem, and a dangling link is not an error.
async function listLinked(
  cards: readonly WorkboardCard[],
  kind: ArtifactKind,
): Promise<WorkboardLinkedNodeFiles[]> {
  const listed = await Promise.all(
    cards.map(async (linked): Promise<WorkboardLinkedNodeFiles | undefined> => {
      const committed = await listCommitted(linked, kind);
      return committed.state === "available" && committed.rounds.length > 0
        ? { cardId: linked.id, title: linked.title, committed }
        : undefined;
    }),
  );
  return listed.filter((entry) => entry !== undefined);
}

async function listCommitted(
  card: WorkboardCard,
  kind: ArtifactKind,
): Promise<WorkboardCommittedNodeFiles> {
  const target = nodeTicketTarget(card);
  const rounds = (target?.worktree?.rounds ?? []).flatMap((entry) =>
    entry.changes ? [{ round: entry.round, changes: entry.changes }] : [],
  );
  if (!target?.hostRepoPath || rounds.length === 0) {
    return { state: "available", rounds: [] };
  }
  const listed: WorkboardNodeFileRound[] = [];
  let missing = 0;
  try {
    for (const { round, changes } of rounds) {
      const paths = await roundPaths(kind, target.hostRepoPath, changes.from, changes.to);
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

/** The round's paths of this kind; undefined when its commits are gone from the host clone. */
async function roundPaths(
  kind: ArtifactKind,
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
    .filter(
      (path) =>
        path && mediaType(kind, path) && (!kind.committedDirs || isUnder(kind.committedDirs, path)),
    )
    .toSorted()
    .slice(0, MAX_LISTED_FILES);
}

export type NodeTicketArtifact = { mimeType: string; bytes: Buffer };

/** One listed file's bytes; paths the source did not list are refused. */
export async function readNodeTicketArtifact(
  runtime: WorkboardNodeTicketRuntime,
  card: WorkboardCard,
  kindName: NodeTicketArtifactKind,
  source: WorkboardNodeFileSource,
  path: string,
): Promise<NodeTicketArtifact> {
  const kind = KINDS[kindName];
  return "live" in source
    ? readLive(runtime, card, kind, path)
    : readRound(card, kind, source.round, path);
}

async function readRound(
  card: WorkboardCard,
  kind: ArtifactKind,
  round: number,
  path: string,
): Promise<NodeTicketArtifact> {
  const target = nodeTicketTarget(card);
  const changes = target?.worktree?.rounds?.find((entry) => entry.round === round)?.changes;
  const mimeType = mediaType(kind, path);
  const paths =
    target && changes && mimeType
      ? await roundPaths(kind, target.hostRepoPath, changes.from, changes.to)
      : undefined;
  if (!target || !changes || !mimeType || !paths?.includes(path)) {
    throw new Error(`${kind.noun} not found: round ${round} ${path}`);
  }
  const repoPath = target.hostRepoPath;
  const object = `${changes.to}:${path}`;
  const size = await hostGit(repoPath, ["cat-file", "-s", object]);
  const bytes = Number(size.stdout.trim());
  if (size.code !== 0 || !Number.isInteger(bytes)) {
    throw new Error(`${kind.noun} ${path} is no longer in ${repoPath}`);
  }
  if (bytes > kind.maxBytes) {
    throw new Error(`${kind.noun} ${path} is ${bytes} bytes, over the ${kind.maxBytes}-byte limit`);
  }
  // The SDK command runner decodes stdout as text, which corrupts image bytes.
  const { stdout } = await execFileAsync("git", ["-C", repoPath, "cat-file", "blob", object], {
    encoding: "buffer",
    maxBuffer: kind.maxBytes + 1,
    timeout: READ_TIMEOUT_MS,
  });
  return { mimeType, bytes: stdout };
}

/** Where the agent writes this kind, and the commit its round started from; undefined once its round was imported and the worktree removed. */
function liveWorktree(card: WorkboardCard, kind: ArtifactKind) {
  const target = nodeTicketTarget(card);
  const worktree = target?.worktree;
  const phase = worktree?.handoff?.phase;
  if (!target || !worktree || phase === "imported" || phase === "published") {
    return undefined;
  }
  return {
    nodeId: target.nodeId,
    root: worktree.path,
    dirs: kind.liveDirs(target),
    from: worktree.rework?.startCommit ?? worktree.baseCommit,
  };
}

function liveUnavailableReason(
  kind: ArtifactKind,
  nodeId: string,
  root: string,
  error: unknown,
): string {
  return `${formatErrorMessage(error)}. Check that node ${nodeId} is connected, that gateway.nodes.commands.allow includes dir.list, file.fetch, and system.run, and that its file-transfer allowReadPaths cover the ${kind.noun} dirs under ${root}.`;
}

/**
 * The worktree files of these dirs the round added or changed: committed or
 * not, tracked or new. Everything else there is inherited from the base branch.
 * Ignored files count: evidence dirs stay gitignored until a run force-adds
 * them, and an untracked file never comes from the base branch.
 */
async function ownedLivePaths(
  runtime: WorkboardNodeTicketRuntime,
  nodeId: string,
  root: string,
  from: string,
  dirs: readonly string[],
): Promise<Set<string>> {
  if (!COMMIT_ID.test(from)) {
    throw new Error(`round start ${from} is not a commit id`);
  }
  const git = (...args: string[]) => runNodeCommand(runtime, nodeId, ["git", "-C", root, ...args]);
  const [changed, untracked] = await Promise.all([
    git("diff", "--name-only", "-z", "--no-renames", "--diff-filter=AM", from, "--", ...dirs),
    git("ls-files", "-z", "--others", "--", ...dirs),
  ]);
  return new Set([...changed.split("\0"), ...untracked.split("\0")].filter(Boolean));
}

/** The kind's files in the live dirs, two levels deep; undefined once the walk is over the deadline. */
async function walkLive(
  runtime: WorkboardNodeTicketRuntime,
  kind: ArtifactKind,
  nodeId: string,
  root: string,
  dirs: readonly string[],
  deadline: number,
  now: () => number,
): Promise<WorkboardLiveNodeFile[] | undefined> {
  const files: WorkboardLiveNodeFile[] = [];
  const pending = dirs.map((dir) => ({ dir, depth: 0 }));
  for (let listings = 0; listings < LIVE_MAX_LISTINGS; listings += 1) {
    const next = pending.shift();
    if (!next) {
      break;
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      return undefined;
    }
    for (const entry of await listNodeDir(runtime, nodeId, posix.join(root, next.dir), {
      maxEntries: LIVE_LIST_ENTRIES,
      timeoutMs: Math.min(DIR_LIST_TIMEOUT_MS, remaining),
    })) {
      const relative = `${next.dir}/${entry.name}`;
      if (entry.isDir && next.depth < LIVE_MAX_DEPTH) {
        pending.push({ dir: relative, depth: next.depth + 1 });
      } else if (entry.isFile && mediaType(kind, entry.name)) {
        files.push({ path: relative, bytes: entry.size, mtimeMs: entry.mtime });
      }
    }
  }
  return files;
}

async function listLive(
  runtime: WorkboardNodeTicketRuntime,
  card: WorkboardCard,
  kind: ArtifactKind,
  now: () => number,
): Promise<WorkboardLiveNodeFiles> {
  const worktree = liveWorktree(card, kind);
  if (!worktree) {
    return { state: "none" };
  }
  const { nodeId, root, dirs, from } = worktree;
  const deadline = now() + LIVE_LIST_DEADLINE_MS;
  const overDeadline = {
    state: "unavailable",
    reason: `listing the ${kind.noun} dirs under ${root} on node ${nodeId} took over ${LIVE_LIST_DEADLINE_MS / 1000} seconds. Check that the node is responsive and that the ${kind.noun} dirs hold few files.`,
  } as const;
  try {
    const [owned, files] = await Promise.all([
      ownedLivePaths(runtime, nodeId, root, from, dirs),
      walkLive(runtime, kind, nodeId, root, dirs, deadline, now),
    ]);
    if (!files) {
      return overDeadline;
    }
    return {
      state: "available",
      files: files
        .filter((file) => owned.has(file.path))
        .toSorted(
          (left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path),
        )
        .slice(0, MAX_LISTED_FILES),
    };
  } catch (error) {
    return now() >= deadline
      ? overDeadline
      : { state: "unavailable", reason: liveUnavailableReason(kind, nodeId, root, error) };
  }
}

/** A live path must sit inside one of the kind's live dirs, at most as deep as the listing walks. */
function isLivePath(dirs: readonly string[], path: string): boolean {
  return dirs.some((dir) => {
    if (!path.startsWith(`${dir}/`)) {
      return false;
    }
    const rest = path.slice(dir.length + 1).split("/");
    return rest.length <= LIVE_MAX_DEPTH + 1 && rest.every(isPathSegment);
  });
}

async function readLive(
  runtime: WorkboardNodeTicketRuntime,
  card: WorkboardCard,
  kind: ArtifactKind,
  path: string,
): Promise<NodeTicketArtifact> {
  const worktree = liveWorktree(card, kind);
  const mimeType = mediaType(kind, path);
  if (!worktree || !mimeType || !isLivePath(worktree.dirs, path)) {
    throw new Error(`${kind.noun} not found: live ${path}`);
  }
  // Same rule as the listing: a file the base branch already had is not this card's.
  const owned = await ownedLivePaths(
    runtime,
    worktree.nodeId,
    worktree.root,
    worktree.from,
    worktree.dirs,
  );
  if (!owned.has(path)) {
    throw new Error(`${kind.noun} not found: live ${path}`);
  }
  const bytes = await fetchNodeFile(
    runtime,
    worktree.nodeId,
    posix.join(worktree.root, path),
    kind.maxBytes,
  );
  return { mimeType, bytes };
}
