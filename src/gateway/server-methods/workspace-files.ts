import path from "node:path";
import { detectMime } from "@openclaw/media-core/mime";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type {
  SessionFileBrowserEntry,
  SessionFileBrowserResult,
  SessionFileEntry,
  SessionFileRelevance,
} from "../../../packages/gateway-protocol/src/index.js";
import { SANDBOX_STATE_DIR } from "../../agents/sandbox/constants.js";
import { resolveSandboxContainerPathMount } from "../../agents/sandbox/fs-paths.js";
import { resolveSandboxHostPathViaExistingAncestor } from "../../agents/sandbox/host-paths.js";
import { insideGitCheckout } from "../../agents/worktrees/git.js";
import { FsSafeError } from "../../infra/fs-safe.js";
import { isPathInside } from "../../infra/path-guards.js";
import { BROWSER_IMAGE_MIME_TYPES } from "../../shared/browser-image-mime-types.js";
import { isWorkspaceScratchPath, SCRATCH_EXPIRED_MESSAGE } from "../../shared/scratch-expiry.js";
import { foldSearchCase } from "../../shared/search-case.js";
import { WORKSPACE_PREVIEW_MAX_BYTES } from "../workspace-file-limits.js";
import {
  resolveSandboxContainerFilePath,
  resolveSessionFileReadTarget,
  resolveSessionRootFilePath,
  type SessionFileReadBoundary,
  type SessionSandboxPaths,
} from "./session-file-read.js";
import {
  decodeUtf8Strict,
  listWorkspacePath,
  normalizeRelativePath,
  openWorkspaceRoot,
  readWorkspaceFile,
  readWorkspaceFilePrefix,
  resolveWorkspacePath,
  sortDirents,
  sortWorkspaceEntries,
  statWorkspacePath,
  toUpdatedAtMs,
  toWorkspaceBrowserEntry,
  type WorkspaceRoot,
  updateWorkspaceFile,
  type WorkspaceFileUpdateResult,
  workspaceRelativePath,
} from "./workspace-fs.js";

export type TouchedFile = { path: string; kind: "modified" | "read" };
export type LoadedSessionFiles = SessionFileReadBoundary & {
  diffCwd?: string;
  files: TouchedFile[];
};
const MAX_BROWSER_ENTRIES = 250;
const MAX_SEARCH_ENTRIES = 500;
const MAX_SEARCH_VISITED_ENTRIES = 5_000;
// Matches file-type's documented default buffer sample while keeping metadata
// classification independent from the 256 KiB inline-content cap.
const MIME_SNIFF_PREFIX_BYTES = 4_100;
const DETECTED_TEXT_MIME_TYPES = new Set([
  "application/rtf",
  "application/xml",
  "application/x-ms-regedit",
  "model/stl",
]);
const SEARCH_IGNORED_DIRS = new Set([".git", ".hg"]);
const SEARCH_INCOMPLETE_DIRS = new Set([
  ".next",
  ".turbo",
  ".yarn",
  "coverage",
  "dist",
  "node_modules",
]);

function resolveTouchedFilePath(params: {
  root: string | undefined;
  fileRoot: string | undefined;
  filePath: string;
  sandbox?: SessionSandboxPaths;
}): string | undefined {
  return resolveSessionRootFilePath(params, params.filePath);
}

export function resolveFileRoot(params: {
  root: string | undefined;
  spawnedCwd: string | undefined;
}): string | undefined {
  if (!params.root) {
    return undefined;
  }
  if (!params.spawnedCwd) {
    return params.root;
  }
  const resolvedCwd = path.resolve(params.spawnedCwd);
  const resolvedRoot = path.resolve(params.root);
  return isPathInside(resolvedRoot, resolvedCwd) ? params.spawnedCwd : params.root;
}

function buildSessionRelevanceMap(
  files: readonly TouchedFile[],
  root: string | undefined,
  fileRoot: string | undefined,
  sandbox?: SessionSandboxPaths,
): Map<string, SessionFileRelevance> {
  const relevance = new Map<string, SessionFileRelevance>();
  if (!root) {
    for (const file of files) {
      relevance.set(normalizeRelativePath(file.path), file.kind);
    }
    return relevance;
  }
  for (const file of files) {
    const resolved = resolveTouchedFilePath({ root, fileRoot, filePath: file.path, sandbox });
    if (!resolved) {
      continue;
    }
    relevance.set(workspaceRelativePath(root, resolved), file.kind);
  }
  return relevance;
}

function displayNameForPath(filePath: string): string {
  return path.basename(filePath) || filePath;
}

function isDetectedTextMime(mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    mimeType.endsWith("+xml") ||
    DETECTED_TEXT_MIME_TYPES.has(mimeType)
  );
}

export async function populateSessionFilePreview(
  entry: SessionFileEntry,
  buffer: Buffer,
): Promise<void> {
  const mimeType = await detectMime({ buffer });
  if (mimeType && BROWSER_IMAGE_MIME_TYPES.has(mimeType)) {
    entry.mimeType = mimeType;
    entry.contentEncoding = "base64";
    entry.previewKind = "image";
    entry.content = buffer.toString("base64");
    return;
  }
  const text = decodeUtf8Strict(buffer);
  if ((!mimeType || isDetectedTextMime(mimeType)) && text !== undefined) {
    entry.mimeType = mimeType ?? "text/plain";
    entry.contentEncoding = "utf8";
    entry.previewKind = "text";
    entry.content = text;
    // The hash doubles as the sessions.files.set CAS token. Binary files
    // never receive one, so replacement characters cannot be saved back.
    entry.hash = sha256Hex(buffer);
    return;
  }
  entry.previewKind = "unsupported";
  if (mimeType) {
    entry.mimeType = mimeType;
  }
}

async function toSessionFileEntry(
  touched: TouchedFile,
  root: string | undefined,
  fileRoot: string | undefined,
  opts: {
    includeContent?: boolean;
    workspaceRoot?: WorkspaceRoot;
    readRoot?: string;
    assertCurrent?: () => void;
    authorizeHostRead?: () => Promise<boolean>;
    onOutsideBoundary?: () => void;
    sandbox?: SessionSandboxPaths;
  } = {},
): Promise<SessionFileEntry | undefined> {
  const target = await resolveSessionFileReadTarget(
    {
      root,
      fileRoot,
      readRoot: opts.readRoot,
      authorizeHostRead: opts.authorizeHostRead,
      sandbox: opts.sandbox,
    },
    touched.path,
  );
  const base = {
    path: touched.path,
    name: displayNameForPath(touched.path),
    kind: touched.kind,
  } satisfies Pick<SessionFileEntry, "path" | "name" | "kind">;
  if (!target || target === "outside_session_boundary") {
    if (target === "outside_session_boundary") {
      opts.onOutsideBoundary?.();
    }
    return { ...base, missing: true };
  }
  const browserPath = target.path;
  const readRoot = target.outside ? target.root : (opts.workspaceRoot ?? target.root);
  const stat = await statWorkspacePath(readRoot, browserPath, opts.assertCurrent);
  // Confirmed directories belong to the browser, not file-only activity.
  if (stat?.isDirectory && !opts.includeContent) {
    return undefined;
  }
  if (!stat?.isFile) {
    return {
      ...base,
      name:
        !stat && isWorkspaceScratchPath(target.absolutePath)
          ? `${SCRATCH_EXPIRED_MESSAGE}: ${base.name}`
          : base.name,
      missing: true,
    };
  }
  const entry: SessionFileEntry = {
    ...base,
    ...(target.outside ? { path: target.absolutePath } : {}),
    workspacePath: target.outside ? target.absolutePath : browserPath,
    missing: false,
    size: stat.size,
    updatedAtMs: toUpdatedAtMs(stat.mtimeMs),
  };
  if (!opts.includeContent) {
    return entry;
  }
  const inline = stat.size <= WORKSPACE_PREVIEW_MAX_BYTES;
  const read = inline
    ? await readWorkspaceFile(readRoot, browserPath, { assertCurrent: opts.assertCurrent })
    : await readWorkspaceFilePrefix(readRoot, browserPath, MIME_SNIFF_PREFIX_BYTES);
  if (!read) {
    return { ...base, missing: true };
  }
  if (read === "too-large" || read === "unsupported") {
    return entry;
  }
  entry.workspacePath = target.outside ? target.absolutePath : read.canonicalPath;
  entry.size = read.stat.size;
  entry.updatedAtMs = toUpdatedAtMs(read.stat.mtimeMs);
  if (inline) {
    await populateSessionFilePreview(entry, read.buffer);
    if (read.readOnly || target.outside) {
      delete entry.hash;
    }
  } else {
    const mimeType = await detectMime({ buffer: read.buffer });
    const prefixIsText = decodeUtf8Strict(read.buffer) !== undefined;
    if (!prefixIsText || (mimeType && !isDetectedTextMime(mimeType))) {
      entry.previewKind = "unsupported";
      if (mimeType) {
        entry.mimeType = mimeType;
      }
    }
  }
  return entry;
}

function resolveSessionFileCandidates(params: {
  root: string;
  fileRoot: string | undefined;
  filePath: string;
  sandbox?: SessionSandboxPaths;
}): string[] {
  return [
    resolveTouchedFilePath(params),
    resolveWorkspacePath(params.root, params.filePath),
  ].filter((candidate, index, all): candidate is string => {
    return candidate !== undefined && all.indexOf(candidate) === index;
  });
}

/** Reveal-in-workspace hands browsing the same path a file link carried. */
function toBrowserRequestPath(params: {
  root: string;
  path?: string;
  sandbox?: SessionSandboxPaths;
}): string {
  const requested = params.path ?? "";
  if (params.sandbox && path.posix.isAbsolute(requested.replaceAll("\\", "/"))) {
    const resolved = resolveSandboxContainerFilePath({
      root: params.root,
      filePath: requested,
      sandbox: params.sandbox,
    });
    if (resolved) {
      return workspaceRelativePath(params.root, resolved);
    }
  }
  return normalizeRelativePath(requested);
}

export async function listSessionWorkspaceFiles(
  params: LoadedSessionFiles & {
    path?: string;
    search?: string;
    assertCurrent?: () => void;
  },
) {
  const root = params.root;
  const workspaceRoot = root ? await openWorkspaceRoot(params.readRoot ?? root) : undefined;
  const gitCheckout =
    workspaceRoot && "access" in workspaceRoot
      ? undefined
      : params.diffCwd
        ? await insideGitCheckout(params.diffCwd)
        : undefined;
  const allowOutside =
    root &&
    params.files.some(
      (file) =>
        !resolveTouchedFilePath({
          root,
          fileRoot: params.fileRoot,
          filePath: file.path,
          sandbox: params.sandbox,
        }),
    ) &&
    (await params.authorizeHostRead?.());
  const workspaceFiles =
    root && !allowOutside
      ? params.files.filter((file) =>
          Boolean(
            resolveTouchedFilePath({
              root,
              fileRoot: params.fileRoot,
              filePath: file.path,
              sandbox: params.sandbox,
            }),
          ),
        )
      : params.files;
  const files = await Promise.all(
    workspaceFiles.map((file) =>
      toSessionFileEntry(file, params.root, params.fileRoot, {
        workspaceRoot,
        assertCurrent: params.assertCurrent,
        authorizeHostRead: params.authorizeHostRead,
        sandbox: params.sandbox,
      }),
    ),
  );
  const { assertCurrent, fileRoot, path: requestedPath, search: requestedSearch } = params;
  const browser = await (async (): Promise<SessionFileBrowserResult | undefined> => {
    if (!root) {
      return undefined;
    }
    const search = normalizeOptionalString(requestedSearch);
    const relevance = buildSessionRelevanceMap(workspaceFiles, root, fileRoot, params.sandbox);
    const readRoot = workspaceRoot ?? root;
    if (search) {
      const entries: SessionFileBrowserEntry[] = [];
      // Normalize comparison text only; on-disk filenames stay original.
      const query = foldSearchCase(search).normalize("NFC");
      let visitedEntries = 0;
      let truncated = false;
      const shouldStop = (): boolean => {
        if (entries.length >= MAX_SEARCH_ENTRIES || visitedEntries >= MAX_SEARCH_VISITED_ENTRIES) {
          truncated = true;
          return true;
        }
        return false;
      };
      const visit = async (dir: string): Promise<void> => {
        if (shouldStop()) {
          return;
        }
        const dirents = await listWorkspacePath(readRoot, dir, assertCurrent);
        if (!dirents) {
          return;
        }
        for (const dirent of sortDirents(dirents)) {
          if (shouldStop()) {
            return;
          }
          visitedEntries += 1;
          const browserPath = dir ? `${dir}/${dirent.name}` : dirent.name;
          if (foldSearchCase(browserPath).normalize("NFC").includes(query)) {
            const entry = toWorkspaceBrowserEntry(browserPath, dirent, relevance);
            if (entry) {
              entries.push(entry);
            }
          }
          if (dirent.isDirectory) {
            if (SEARCH_INCOMPLETE_DIRS.has(dirent.name)) {
              // The public result only has a boolean completeness signal. A skipped
              // directory can contain another filename match, so searches that saw
              // one must not be presented as workspace-wide unique.
              truncated = true;
            } else if (!SEARCH_IGNORED_DIRS.has(dirent.name)) {
              await visit(browserPath);
            }
          }
        }
      };
      await visit("");
      return {
        path: "",
        search,
        entries: sortWorkspaceEntries(entries),
        ...(truncated ? { truncated } : {}),
      };
    }
    const browserPath = toBrowserRequestPath({
      root,
      path: requestedPath,
      sandbox: params.sandbox,
    });
    const resolved = resolveWorkspacePath(root, browserPath);
    if (!resolved) {
      return undefined;
    }
    // Local roots are admitted directories; listing rechecks their identity.
    if (
      (browserPath || !workspaceRoot || "access" in workspaceRoot) &&
      !(await statWorkspacePath(readRoot, browserPath, assertCurrent))?.isDirectory
    ) {
      return undefined;
    }
    const dirents = await listWorkspacePath(readRoot, browserPath, assertCurrent);
    if (!dirents) {
      return undefined;
    }
    const entries = sortDirents(dirents)
      .slice(0, MAX_BROWSER_ENTRIES + 1)
      .map((dirent) => {
        const entryPath = browserPath ? `${browserPath}/${dirent.name}` : dirent.name;
        return toWorkspaceBrowserEntry(entryPath, dirent, relevance);
      })
      .filter((entry): entry is SessionFileBrowserEntry => Boolean(entry));
    const parent = path.dirname(browserPath);
    return {
      path: browserPath,
      ...(browserPath ? { parentPath: parent === "." ? "" : parent } : {}),
      entries: sortWorkspaceEntries(entries.slice(0, MAX_BROWSER_ENTRIES)),
      ...(entries.length > MAX_BROWSER_ENTRIES ? { truncated: true } : {}),
    };
  })();
  return {
    ...(root ? { root } : {}),
    ...(gitCheckout === undefined ? {} : { gitCheckout }),
    files: files.filter((file) => file !== undefined),
    ...(browser ? { browser } : {}),
  };
}

export async function getSessionWorkspaceFile(
  params: LoadedSessionFiles & {
    path: string;
    /** The caller's container spelling when `path` is already the prepared host path. */
    requestedPath?: string;
    assertCurrent?: () => void;
    includeContent?: boolean;
  },
): Promise<{ root?: string; file?: SessionFileEntry; reason?: "outside_session_boundary" }> {
  const result = await getSessionRootFile(params);
  if (result.file && !result.file.missing) {
    return result;
  }
  const mounted = await getSandboxMountedFile({
    ...params,
    path: params.requestedPath ?? params.path,
  });
  return mounted ? { root: result.root, file: mounted } : result;
}

/**
 * A sandboxed agent also reads files whose mount source lives outside the
 * session root, such as the materialized skills workspace under the sandbox
 * state dir. The session root cannot serve those, so the preview opens the
 * mount's own host root instead; fs-safe containment then applies to what the
 * container was actually given. Only mounts sourced from the Gateway-owned
 * sandbox state dir qualify: custom binds keep daemon-host paths that may name
 * a different Gateway-local file, and widening previews to every operator bind
 * is not this fallback's job. The entry carries no hash, which keeps it
 * read-only: sessions.files.set still only writes inside the session root.
 */
async function getSandboxMountedFile(
  params: LoadedSessionFiles & { path: string; assertCurrent?: () => void },
): Promise<SessionFileEntry | undefined> {
  if (!params.sandbox) {
    return undefined;
  }
  const target = resolveSandboxContainerPathMount({
    containerPath: params.path,
    mounts: params.sandbox.mounts,
  });
  if (
    !target?.relativePath ||
    !isPathInside(
      resolveSandboxHostPathViaExistingAncestor(SANDBOX_STATE_DIR),
      resolveSandboxHostPathViaExistingAncestor(target.hostRoot),
    )
  ) {
    return undefined;
  }
  const touched = params.files.find((file) => file.path === params.path);
  const entry = await toSessionFileEntry(
    { path: target.relativePath, kind: touched?.kind ?? "read" },
    target.hostRoot,
    target.hostRoot,
    { includeContent: true, assertCurrent: params.assertCurrent },
  );
  if (!entry || entry.missing) {
    return undefined;
  }
  const { hash: _hash, workspacePath: _workspacePath, ...readOnly } = entry;
  return { ...readOnly, path: params.path };
}

async function getSessionRootFile(
  params: LoadedSessionFiles & {
    path: string;
    assertCurrent?: () => void;
    includeContent?: boolean;
  },
): Promise<{ root?: string; file?: SessionFileEntry; reason?: "outside_session_boundary" }> {
  let outsideBoundary = false;
  const options = {
    readRoot: params.readRoot,
    includeContent: params.includeContent !== false,
    assertCurrent: params.assertCurrent,
    authorizeHostRead: params.authorizeHostRead,
    sandbox: params.sandbox,
    onOutsideBoundary: () => {
      outsideBoundary = true;
    },
  };
  let touched = params.files.find((file) => file.path === params.path);
  if (!touched) {
    if (!params.root) {
      return {};
    }
    // Any in-root file is previewable; fs-safe enforces containment and read bounds.
    const candidates = resolveSessionFileCandidates({
      root: params.root,
      fileRoot: params.fileRoot,
      filePath: params.path,
      sandbox: params.sandbox,
    });
    if (
      candidates.length > 0 &&
      resolveTouchedFilePath({
        root: params.root,
        fileRoot: params.fileRoot,
        filePath: params.path,
        sandbox: params.sandbox,
      })
    ) {
      const relevance = buildSessionRelevanceMap(
        params.files,
        params.root,
        params.fileRoot,
        params.sandbox,
      );
      for (const candidate of candidates) {
        const browserPath = workspaceRelativePath(params.root, candidate);
        const sessionKind = relevance.get(browserPath);
        const file = await toSessionFileEntry(
          {
            path: browserPath,
            kind: sessionKind === "modified" ? "modified" : "read",
          },
          params.root,
          params.root,
          options,
        );
        if (file && !file.missing) {
          return { root: params.root, file };
        }
      }
      return { root: params.root };
    }
    touched = { path: params.path, kind: "read" };
  }
  const file = await toSessionFileEntry(touched, params.root, params.fileRoot, options);
  return {
    ...(params.root ? { root: params.root } : {}),
    file,
    ...(outsideBoundary ? { reason: "outside_session_boundary" as const } : {}),
  };
}

export async function setSessionWorkspaceFile(params: {
  root?: string;
  fileRoot?: string;
  path: string;
  content: string;
  expectedHash: string;
  assertCurrent?: () => void;
  sandbox?: SessionSandboxPaths;
}) {
  // Reject content the preview cannot round-trip, before encoding oversized input.
  if (params.content.includes("\0")) {
    return { status: "unsafe" as const };
  }
  const size = Buffer.byteLength(params.content, "utf8");
  if (size > WORKSPACE_PREVIEW_MAX_BYTES) {
    return { status: "too-large" as const, size };
  }
  if (Buffer.from(params.content, "utf8").toString("utf8") !== params.content) {
    return { status: "unsafe" as const };
  }
  if (!params.root) {
    return { status: "missing" as const };
  }
  // The preview can open a file by container path, so saving it back must reach
  // the same candidate; containment against the root still gates the write.
  const candidates = resolveSessionFileCandidates({
    root: params.root,
    fileRoot: params.fileRoot,
    filePath: params.path,
    sandbox: params.sandbox,
  });
  let browserPath: string | undefined;
  for (const candidate of candidates) {
    const candidatePath = workspaceRelativePath(params.root, candidate);
    const stat = await statWorkspacePath(params.root, candidatePath);
    if (stat?.isFile) {
      browserPath = candidatePath;
      break;
    }
  }
  if (!browserPath) {
    return { status: "missing" as const };
  }
  let update: WorkspaceFileUpdateResult;
  try {
    update = await updateWorkspaceFile(
      params.root,
      browserPath,
      params.content,
      params.expectedHash,
      params.assertCurrent,
    );
  } catch (error) {
    if (!(error instanceof FsSafeError)) {
      throw error;
    }
    return { status: "unsafe" as const };
  }
  if (update.status !== "updated") {
    return update;
  }
  return {
    status: "updated" as const,
    root: params.root,
    file: {
      path: params.path,
      workspacePath: update.canonicalPath,
      name: displayNameForPath(update.canonicalPath),
      kind: "modified" as const,
      missing: false,
      size: update.stat.size,
      updatedAtMs: toUpdatedAtMs(update.stat.mtimeMs),
      hash: update.hash,
    },
  };
}
