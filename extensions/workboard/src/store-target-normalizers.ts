import type { WorkboardExecutionTarget, WorkboardNodeWorktree } from "@openclaw/workboard-contract";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeBoundedString } from "./store-value-normalizers.js";
import { isAbsoluteWorkspacePath } from "./workspace-path.js";

function normalizeNodeWorktree(value: unknown): WorkboardNodeWorktree | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const worktreePath = normalizeBoundedString(value.path, undefined, 2000, "node worktree path");
  const branch = normalizeBoundedString(value.branch, undefined, 160, "node worktree branch");
  const baseCommit = normalizeBoundedString(
    value.baseCommit,
    undefined,
    64,
    "node worktree base commit",
  );
  return worktreePath && branch && baseCommit
    ? { path: worktreePath, branch, baseCommit }
    : undefined;
}

/** The recorded worktree is dispatcher state; raw input can only keep it for the same target. */
export function normalizeExecutionTarget(
  value: unknown,
  fallback?: WorkboardExecutionTarget,
  options: { allowLaunchState?: boolean } = {},
): WorkboardExecutionTarget | undefined {
  if (value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    return fallback;
  }
  if (value.kind !== "node-claude") {
    throw new Error("execution target kind must be node-claude.");
  }
  const nodeId = normalizeBoundedString(value.nodeId, undefined, 200, "target node id");
  const repoPath = normalizeBoundedString(value.repoPath, undefined, 2000, "target repo path");
  const worktreesRoot = normalizeBoundedString(
    value.worktreesRoot,
    undefined,
    2000,
    "target worktrees root",
  );
  if (!nodeId || !repoPath || !worktreesRoot) {
    throw new Error("node-claude target needs nodeId, repoPath, and worktreesRoot.");
  }
  if (!isAbsoluteWorkspacePath(repoPath) || !isAbsoluteWorkspacePath(worktreesRoot)) {
    throw new Error("node-claude target paths must be absolute.");
  }
  const baseRef = normalizeBoundedString(value.baseRef, undefined, 160, "target base ref");
  const model = normalizeBoundedString(value.model, undefined, 160, "target model");
  const sameTarget =
    fallback?.nodeId === nodeId &&
    fallback.repoPath === repoPath &&
    fallback.worktreesRoot === worktreesRoot;
  const worktree = options.allowLaunchState
    ? normalizeNodeWorktree(value.worktree)
    : sameTarget
      ? fallback.worktree
      : undefined;
  return {
    kind: "node-claude",
    nodeId,
    repoPath,
    worktreesRoot,
    ...(baseRef ? { baseRef } : {}),
    ...(model ? { model } : {}),
    ...(worktree ? { worktree } : {}),
  };
}
