import { expect, it } from "vitest";
import { normalizeExecutionTarget } from "./store-target-normalizers.js";

const NODE_TARGET = {
  kind: "node-claude",
  nodeId: "mac-factory",
  repoPath: "/Users/factory/repos/app",
  worktreesRoot: "/Users/factory/worktrees",
  hostRepoPath: "/home/openclaw/repos/app",
};

it("keeps a target's worktree-relative screenshot dirs, trimmed and deduplicated", () => {
  expect(
    normalizeExecutionTarget({
      ...NODE_TARGET,
      screenshotDirs: [" docs/screenshots/ ", "features/evidence", "docs/screenshots"],
    })?.screenshotDirs,
  ).toEqual(["docs/screenshots", "features/evidence"]);
  expect(normalizeExecutionTarget(NODE_TARGET)).not.toHaveProperty("screenshotDirs");
  expect(normalizeExecutionTarget({ ...NODE_TARGET, screenshotDirs: null })).not.toHaveProperty(
    "screenshotDirs",
  );
});

it("refuses screenshot dirs that could leave the worktree or are unbounded", () => {
  for (const dir of [
    "/abs/shots",
    "../shots",
    "docs/../../shots",
    "docs/./shots",
    "docs//shots",
    "a\\b",
    "",
    "x".repeat(201),
    3,
  ]) {
    expect(() => normalizeExecutionTarget({ ...NODE_TARGET, screenshotDirs: [dir] })).toThrow(
      "must be a relative path inside the worktree",
    );
  }
  for (const screenshotDirs of [
    [],
    "docs/screenshots",
    Array.from({ length: 9 }, (_, i) => `d${i}`),
  ]) {
    expect(() => normalizeExecutionTarget({ ...NODE_TARGET, screenshotDirs })).toThrow(
      "target screenshotDirs must be an array of 1 to 8",
    );
  }
});

it("drops the recorded worktree when the target moves to another node", () => {
  const worktree = {
    path: "/Users/factory/worktrees/c1",
    branch: "factory/c1",
    baseCommit: "",
    rounds: [],
  };
  const recorded = { ...NODE_TARGET, kind: "node-claude" as const, worktree };

  expect(normalizeExecutionTarget({ ...NODE_TARGET, worktree: {} }, recorded)?.worktree).toEqual(
    worktree,
  );
  expect(
    normalizeExecutionTarget({ ...NODE_TARGET, nodeId: "linux-factory", worktree }, recorded),
  ).not.toHaveProperty("worktree");
});
