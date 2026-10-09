import type {
  WorkboardExecutionTarget,
  WorkboardNodeHandoff,
  WorkboardNodeRework,
  WorkboardNodeWorktree,
} from "@openclaw/workboard-contract";
import { resolveOptionalIntegerOption } from "openclaw/plugin-sdk/number-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeBoundedString } from "./store-value-normalizers.js";
import { isAbsoluteWorkspacePath } from "./workspace-path.js";

function normalizeNodeHandoff(value: unknown): WorkboardNodeHandoff | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value.phase === "pending") {
    const reportedAt = resolveOptionalIntegerOption(value.reportedAt, { min: 0 });
    return reportedAt === undefined ? undefined : { phase: "pending", reportedAt };
  }
  if (value.phase !== "imported" && value.phase !== "published") {
    return undefined;
  }
  const importedAt = resolveOptionalIntegerOption(value.importedAt, { min: 0 });
  const headCommit = normalizeBoundedString(
    value.headCommit,
    undefined,
    64,
    "node handoff head commit",
  );
  if (importedAt === undefined || !headCommit) {
    return undefined;
  }
  if (value.phase === "imported") {
    return { phase: "imported", headCommit, importedAt };
  }
  const publishedAt = resolveOptionalIntegerOption(value.publishedAt, { min: 0 });
  const pullRequestUrl = normalizeBoundedString(
    value.pullRequestUrl,
    undefined,
    500,
    "node handoff pull request url",
  );
  return publishedAt === undefined || !pullRequestUrl
    ? undefined
    : { phase: "published", headCommit, importedAt, publishedAt, pullRequestUrl };
}

function normalizeNodeRework(value: unknown): WorkboardNodeRework | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const round = resolveOptionalIntegerOption(value.round, { min: 1 });
  const outsideCommits = resolveOptionalIntegerOption(value.outsideCommits, { min: 0 });
  const pullRequestUrl = normalizeBoundedString(
    value.pullRequestUrl,
    undefined,
    500,
    "node rework pull request url",
  );
  return round === undefined || outsideCommits === undefined || !pullRequestUrl
    ? undefined
    : { round, pullRequestUrl, outsideCommits };
}

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
  const handoff = normalizeNodeHandoff(value.handoff);
  const rework = normalizeNodeRework(value.rework);
  return worktreePath && branch && baseCommit
    ? {
        path: worktreePath,
        branch,
        baseCommit,
        ...(handoff ? { handoff } : {}),
        ...(rework ? { rework } : {}),
      }
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
  const hostRepoPath = normalizeBoundedString(
    value.hostRepoPath,
    undefined,
    2000,
    "target host repo path",
  );
  if (!nodeId || !repoPath || !worktreesRoot || !hostRepoPath) {
    throw new Error("node-claude target needs nodeId, repoPath, worktreesRoot, and hostRepoPath.");
  }
  if (
    !isAbsoluteWorkspacePath(repoPath) ||
    !isAbsoluteWorkspacePath(worktreesRoot) ||
    !isAbsoluteWorkspacePath(hostRepoPath)
  ) {
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
    hostRepoPath,
    ...(baseRef ? { baseRef } : {}),
    ...(model ? { model } : {}),
    ...(worktree ? { worktree } : {}),
  };
}
