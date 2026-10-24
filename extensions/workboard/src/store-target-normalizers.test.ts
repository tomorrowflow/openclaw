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

it("keeps a recorded round's standards review and its findings", () => {
  const review = {
    findings: 2,
    fixed: 1,
    note: "Left the bare except",
    items: [
      { path: "src/parser.ts", line: 4, rule: "Name the why", body: "Bare except", fixed: false },
      { path: "src/parser.ts", line: 9, body: "Unused import", fixed: true },
    ],
  };
  const worktree = {
    path: "/Users/factory/worktrees/c1",
    branch: "factory/c1",
    baseCommit: "a".repeat(40),
    rounds: [{ round: 0, review }],
  };

  expect(
    normalizeExecutionTarget({ ...NODE_TARGET, worktree }, undefined, { allowLaunchState: true })
      ?.worktree?.rounds,
  ).toEqual([{ round: 0, review }]);
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

it("keeps a round's verification record and a review's verification, dropping malformed ones", () => {
  const base = {
    path: "/Users/factory/worktrees/c1",
    branch: "factory/c1",
    baseCommit: "a".repeat(40),
  };
  const normalize = (worktree: Record<string, unknown>) =>
    normalizeExecutionTarget({ ...NODE_TARGET, worktree: { ...base, ...worktree } }, undefined, {
      allowLaunchState: true,
    })?.worktree;
  const running = {
    phase: "running",
    round: 1,
    headCommit: "b".repeat(40),
    startedAt: 10,
    sessionKey: "agent:verifier:verify-c1-r1",
    path: "/Users/factory/worktrees/verify-c1-r1",
    model: "openai/gpt-6-sol",
  };
  const done = {
    phase: "done",
    round: 0,
    headCommit: "b".repeat(40),
    startedAt: 10,
    endedAt: 20,
    sessionKey: "agent:verifier:verify-c1-r0",
    model: "openai/gpt-6-sol",
    verdict: "fail",
    summary: "pytest fails on empty input",
    findings: [
      { path: "src/parser.py", line: 4, body: "returns None on empty input" },
      { path: "docs/parser.md", body: "says [] is returned" },
    ],
  };

  expect(normalize({ verification: running })?.verification).toEqual(running);
  expect(normalize({ verification: done })?.verification).toEqual(done);
  expect(
    normalize({ verification: { ...done, findings: [{ path: "/abs", body: "x" }, { line: 2 }] } })
      ?.verification,
  ).toMatchObject({ findings: [] });
  for (const broken of [
    { ...running, path: undefined },
    { ...done, verdict: "maybe" },
    { ...done, endedAt: undefined },
    { ...done, phase: "pending" },
  ]) {
    expect(normalize({ verification: broken })).not.toHaveProperty("verification");
  }
  expect(
    normalize({
      reviews: [
        {
          round: 0,
          verdict: "accept",
          verification: { verdict: "pass", model: "openai/gpt-6-sol" },
        },
        { round: 1, verdict: "rework", verification: { verdict: "nope" } },
      ],
    })?.reviews,
  ).toEqual([
    { round: 0, verdict: "accept", verification: { verdict: "pass", model: "openai/gpt-6-sol" } },
    { round: 1, verdict: "rework" },
  ]);
});
