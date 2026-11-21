import path from "node:path";
import { resolveSandboxPathMapping } from "../../agents/path-policy.js";
import {
  resolveSandboxContainerPathMount,
  resolveSandboxHostPathForContainerPath,
  type SandboxContainerMount,
} from "../../agents/sandbox/fs-paths.js";
import { resolveSandboxHostPathViaExistingAncestor } from "../../agents/sandbox/host-paths.js";
import { resolveToCwd } from "../../agents/sessions/tools/path-utils.js";
import { getAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import { resolveAbsolutePathForRead, root as fsSafeRoot } from "../../infra/fs-safe.js";
import { isPathInside } from "../../infra/path-guards.js";
import type { SessionFileSandboxWorkspace } from "../session-file-workspace.js";
import { sessionMutationForbiddenError } from "../session-mutation-authorization-error.js";
import { WORKSPACE_PREVIEW_MAX_BYTES } from "../workspace-file-limits.js";
import type { WorkspaceRoot } from "./workspace-fs.js";

/** The container->host mapping used to translate container paths back to this root. */
export type SessionSandboxPaths = { mounts: readonly SandboxContainerMount[] };

export type SessionFileReadBoundary = {
  root?: string;
  fileRoot?: string;
  /** Physical live backing; root/fileRoot retain the public workspace namespace. */
  readRoot?: string;
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

/** Translate a sandbox reference only after its existing allocation proves the same backing. */
export async function prepareSessionFileReadPath(
  params: SessionFileReadBoundary & {
    filePath?: string;
    sandboxWorkspace?: SessionFileSandboxWorkspace;
    worktreeId?: string;
    historical?: boolean;
    assertCurrent: () => void;
    assertReadCurrent: () => void;
  },
): Promise<{ path: string | null | undefined; readRoot?: string; assertCurrent?: () => void }> {
  const sandbox = params.sandboxWorkspace;
  const absolute =
    params.filePath && params.root
      ? resolveToCwd(params.filePath, params.fileRoot ?? params.root)
      : undefined;
  const mapped =
    absolute && params.root && sandbox && !isPathInside(params.root, absolute)
      ? resolveSandboxPathMapping([sandbox], absolute)
      : null;
  let assertWorkspaceCurrent: (() => void) | undefined;
  const assertCurrent = () => {
    assertWorkspaceCurrent?.();
    params.assertReadCurrent();
    if (mapped && params.root && getAgentWorkspaceAccess(params.root)) {
      throw sessionMutationForbiddenError("Sandbox file backing is not on this Gateway");
    }
  };
  if (mapped) {
    assertCurrent();
  }
  let runtimeWorkspaceDir: string | undefined = sandbox?.runtimeWorkspaceDir;
  let backingRoot = sandbox?.hostRoot;
  let readRoot: string | undefined;
  if (sandbox && params.worktreeId && params.root && !params.historical) {
    const { readLocalWorkspacePath } =
      await import("../worker-environments/local-workspace-read.js");
    const backing = await readLocalWorkspacePath({
      cwd: params.root,
      worktreeId: params.worktreeId,
      assertCurrent: params.assertCurrent,
    });
    if (mapped && backing.worktreeId !== params.worktreeId) {
      return { path: null };
    }
    assertWorkspaceCurrent = backing.assertCurrent;
    readRoot = backing.root;
    runtimeWorkspaceDir = backingRoot = readRoot;
    assertCurrent();
  }
  if (!mapped || !sandbox || !absolute) {
    return { path: params.filePath, readRoot, assertCurrent };
  }
  // Without live backing proof (no registered container, as after every deploy,
  // or a nested mount such as /workspace/shared or the skills mount, which the
  // proof reads as a shadowed alias), the session's mount table still names the
  // host file the container was given. The container spelling passes on to the
  // file surface, which translates it through that table under the same root
  // containment and host-read grant as any other requested path.
  const unproven = () =>
    params.sandbox &&
    resolveSandboxContainerPathMount({ containerPath: absolute, mounts: params.sandbox.mounts })
      ? { path: params.filePath }
      : { path: null };
  if (
    !params.root ||
    !isPathInside(params.root, mapped.hostPath) ||
    !runtimeWorkspaceDir ||
    !backingRoot
  ) {
    return unproven();
  }
  try {
    const { prepareLocalWorkspaceFileRead } =
      await import("../../agents/sandbox/local-workspace-quiescence.js");
    assertCurrent();
    const assertBackingCurrent = await prepareLocalWorkspaceFileRead({
      workspaceDir: backingRoot,
      runtimeWorkspaceDir,
      containerRoot: sandbox.containerRoot,
      targets: [absolute],
      assertCurrent,
    });
    assertBackingCurrent();
    return { path: mapped.hostPath, readRoot, assertCurrent: assertBackingCurrent };
  } catch {
    params.assertReadCurrent();
    // Without a session mount table (guest sessions), an unavailable or shadowed
    // alias is never retried as a host filesystem grant.
    return unproven();
  }
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
      root: boundary.readRoot ?? boundary.root,
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
