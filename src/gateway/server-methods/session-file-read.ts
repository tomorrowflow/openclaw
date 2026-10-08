import path from "node:path";
import {
  resolveSandboxHostPathForContainerPath,
  type SandboxContainerMount,
} from "../../agents/sandbox/fs-paths.js";
import { resolveSandboxHostPathViaExistingAncestor } from "../../agents/sandbox/host-paths.js";
import { resolveToCwd } from "../../agents/sessions/tools/path-utils.js";
import { resolveAbsolutePathForRead, root as fsSafeRoot } from "../../infra/fs-safe.js";
import { isPathInside } from "../../infra/path-guards.js";
import { WORKSPACE_PREVIEW_MAX_BYTES } from "../workspace-file-limits.js";
import type { WorkspaceRoot } from "./workspace-fs.js";

/** The container->host mapping used to translate container paths back to this root. */
export type SessionSandboxPaths = { mounts: readonly SandboxContainerMount[] };

export type SessionFileReadBoundary = {
  root?: string;
  fileRoot?: string;
  authorizeHostRead?: () => Promise<boolean>;
  sandbox?: SessionSandboxPaths;
};

/**
 * Sandboxed agents name files by container path, so `/workspace/...` never
 * resolves against the Gateway-local root on its own. The sandbox mount
 * selection owns the translation; containment against this root still decides
 * whether the file may be served, and the candidate keeps the caller's root
 * spelling so display paths stay relative to it.
 */
export function resolveSandboxContainerFilePath(params: {
  root: string;
  filePath: string;
  sandbox?: SessionSandboxPaths;
}): string | undefined {
  if (!params.sandbox) {
    return undefined;
  }
  const hostPath = resolveSandboxHostPathForContainerPath({
    containerPath: params.filePath,
    mounts: params.sandbox.mounts,
  });
  if (!hostPath) {
    return undefined;
  }
  const canonicalRoot = resolveSandboxHostPathViaExistingAncestor(params.root);
  return isPathInside(canonicalRoot, hostPath)
    ? path.resolve(params.root, path.relative(canonicalRoot, hostPath))
    : undefined;
}

/** Resolves a session-recorded path inside the session root, translating container paths. */
export function resolveSessionRootFilePath(
  boundary: SessionFileReadBoundary,
  filePath: string,
): string | undefined {
  if (!boundary.root) {
    return undefined;
  }
  const resolved = resolveToCwd(filePath, boundary.fileRoot ?? boundary.root);
  if (isPathInside(boundary.root, resolved)) {
    return resolved;
  }
  // A sandboxed agent records the file under its container path, which never
  // resolves against this root on its own. The mount table owns that spelling,
  // so the touched entry resolves through it rather than counting as missing.
  return resolveSandboxContainerFilePath({
    root: boundary.root,
    filePath,
    ...(boundary.sandbox ? { sandbox: boundary.sandbox } : {}),
  });
}

/** Containment is decided before probing host paths, including paths that do not exist. */
export async function resolveSessionFileReadTarget(
  boundary: SessionFileReadBoundary,
  filePath: string,
): Promise<
  | { root: string | WorkspaceRoot; path: string; absolutePath: string; outside: boolean }
  | "outside_session_boundary"
  | undefined
> {
  if (!boundary.root) {
    return undefined;
  }
  const inRootPath = resolveSessionRootFilePath(boundary, filePath);
  if (inRootPath) {
    return {
      root: boundary.root,
      path: path.relative(boundary.root, inRootPath),
      absolutePath: inRootPath,
      outside: false,
    };
  }
  const absolutePath = resolveToCwd(filePath, boundary.fileRoot ?? boundary.root);
  if (!(await boundary.authorizeHostRead?.())) {
    return "outside_session_boundary";
  }
  try {
    const { canonicalPath } = await resolveAbsolutePathForRead(absolutePath, {
      symlinks: "follow",
    });
    // A host read uses a local fs-safe handle, never another workspace's remote adapter.
    const root = await fsSafeRoot(path.dirname(canonicalPath), {
      hardlinks: "allow",
      symlinks: "reject",
      nonBlockingRead: true,
      maxBytes: WORKSPACE_PREVIEW_MAX_BYTES,
    });
    return { root, path: path.basename(canonicalPath), absolutePath: canonicalPath, outside: true };
  } catch {
    return undefined;
  }
}
