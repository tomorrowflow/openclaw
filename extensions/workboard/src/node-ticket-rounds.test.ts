// Workboard tests cover a node ticket round's decision trail, review findings, budget trim, and import diffstat.
import type {
  WorkboardComment,
  WorkboardNodeRound,
  WorkboardNodeWorktree,
} from "@openclaw/workboard-contract";
import { describe, expect, it } from "vitest";
import {
  normalizeNodeDecisions,
  normalizeNodeFindings,
  normalizeNodeReview,
  parseNumstat,
  withNodeRound,
} from "./node-ticket-rounds.js";
import { MAX_CARD_METADATA_BYTES } from "./store-constants.js";
import { trimMetadataToBudget } from "./store-metadata-budget.js";

const worktree: WorkboardNodeWorktree = {
  path: "/wt/wb-card-1",
  branch: "factory/card-1",
  baseCommit: "a".repeat(40),
};

describe("node ticket decision trail", () => {
  it("keeps one-line rows with a phase and a decision, capping each cell", () => {
    expect(
      normalizeNodeDecisions([
        {
          ts: "2026-10-14T10:02Z",
          phase: "plan",
          decision: "Return [] for empty input\n  instead of raising",
          why: "callers iterate the result",
          evidence: "parser.py:12",
          result: "chosen",
          extra: "ignored",
        },
        { phase: "build" },
        { decision: "no phase" },
        "verify: tests pass",
        { phase: "verify", decision: "x".repeat(300), evidence: 42 },
      ]),
    ).toEqual([
      {
        ts: "2026-10-14T10:02Z",
        phase: "plan",
        decision: "Return [] for empty input instead of raising",
        why: "callers iterate the result",
        evidence: "parser.py:12",
        result: "chosen",
      },
      { phase: "verify", decision: `${"x".repeat(159)}…` },
    ]);
    expect(normalizeNodeDecisions(undefined)).toEqual([]);
    expect(normalizeNodeDecisions({ phase: "plan", decision: "not a list" })).toEqual([]);
  });

  it("keeps the newest rows within the row and character caps", () => {
    const rows = Array.from({ length: 35 }, (_, index) => ({
      phase: "build",
      decision: `step ${index}`,
    }));
    const kept = normalizeNodeDecisions(rows);
    expect(kept).toHaveLength(30);
    expect(kept[0]?.decision).toBe("step 5");
    expect(kept.at(-1)?.decision).toBe("step 34");

    const long = Array.from({ length: 20 }, (_, index) => ({
      phase: "build",
      decision: `${index} ${"d".repeat(150)}`,
      why: "w".repeat(150),
    }));
    const budgeted = normalizeNodeDecisions(long);
    expect(budgeted.length).toBeLessThan(20);
    expect(budgeted.at(-1)?.decision.startsWith("19 ")).toBe(true);
  });

  it("appends a round's reports and keeps rework rounds apart", () => {
    const first = withNodeRound(worktree, {
      decisions: [{ phase: "plan", decision: "ask about empty input" }],
    });
    const answered = withNodeRound(first, {
      decisions: [{ phase: "build", decision: "return []" }],
    });
    const review = { findings: 1, fixed: 0, note: "Left one" };
    const reviewed = withNodeRound(answered, {
      review: { findings: 2, fixed: 2 },
    });
    // A retried turn's done report replaces the round's review.
    const reviewedAgain = withNodeRound(reviewed, { review });
    const changes = parseNumstat("1\t0\tparser.py\0", "a".repeat(40), "b".repeat(40));
    const imported = withNodeRound(reviewedAgain, { changes });
    const rework = withNodeRound(
      {
        ...imported,
        rework: {
          round: 1,
          pullRequestUrl: "https://github.com/acme/app/pull/7",
          acceptedAt: 1,
          outsideCommits: 0,
        },
      },
      { decisions: [{ phase: "fix", decision: "rename the flag" }] },
    );

    expect(rework.rounds).toEqual([
      {
        round: 0,
        decisions: [
          { phase: "plan", decision: "ask about empty input" },
          { phase: "build", decision: "return []" },
        ],
        changes,
        review,
      },
      { round: 1, decisions: [{ phase: "fix", decision: "rename the flag" }] },
    ]);
  });
});

describe("node ticket review findings", () => {
  it("keeps repo-relative paths and refuses ones that could leave the repo", () => {
    const finding = (path: string) => ({ path, line: 3, body: `At ${path}` });

    expect(
      normalizeNodeFindings([
        finding("./src/a.ts"),
        finding("src/..cache/b.ts"),
        finding("/repo/src/a.ts"),
        finding("C:\\repo\\a.ts"),
        finding("src/../../etc/passwd"),
        finding("src\\..\\a.ts"),
        finding("src/a\u0007.ts"),
        finding("src/a\u007f.ts"),
      ]).map((item) => item.path),
    ).toEqual(["src/a.ts", "src/..cache/b.ts"]);
  });

  it("marks a finding fixed only when the report says true", () => {
    const finding = (fixed: unknown) => ({ path: "src/a.ts", line: 1, body: "Bare except", fixed });

    expect(
      normalizeNodeFindings([finding(true), finding("true"), finding(1), finding(undefined)]).map(
        (item) => item.fixed,
      ),
    ).toEqual([true, false, false, false]);
  });

  it("keeps open findings first within the character cap", () => {
    // Each finding counts 300 characters (path, rule, body), so 8 fit the 2400 cap.
    const items = Array.from({ length: 12 }, (_, index) => ({
      path: `src/${index}`.padEnd(20, "p"),
      line: index + 1,
      rule: "r".repeat(80),
      body: "b".repeat(200),
      fixed: index < 6,
    }));

    const review = normalizeNodeReview({ findings: 12, fixed: 6, items });
    expect(review?.items?.map((item) => item.line)).toEqual([7, 8, 9, 10, 11, 12, 1, 2]);
  });
});

/** A round at every cap: 30 decision rows, 12 findings, 30 changed files. */
function fullRound(round: number): WorkboardNodeRound {
  const decisions = normalizeNodeDecisions(
    Array.from({ length: 30 }, (_, index) => ({
      ts: `${index}`.padEnd(16, "t"),
      phase: "p".repeat(16),
      decision: "d".repeat(16),
      why: "w".repeat(16),
      evidence: "e".repeat(16),
      result: "r".repeat(16),
    })),
  );
  const review = normalizeNodeReview({
    findings: 12,
    fixed: 0,
    items: Array.from({ length: 12 }, (_, index) => ({
      path: `src/${index}`.padEnd(20, "p"),
      line: 1000 + index,
      rule: "r".repeat(80),
      body: "b".repeat(100),
    })),
  });
  const changes = parseNumstat(
    Array.from(
      { length: 30 },
      (_, index) => `1000\t1000\t${`src/${index}`.padEnd(50, "f")}\0`,
    ).join(""),
    "a".repeat(40),
    "b".repeat(40),
  );
  return { round, decisions, changes, ...(review ? { review } : {}) };
}

function trimRounds(rounds: WorkboardNodeRound[], comments: WorkboardComment[]) {
  return trimMetadataToBudget({
    comments,
    automation: {
      target: {
        kind: "node-claude",
        nodeId: "node",
        repoPath: "/repo",
        worktreesRoot: "/wt",
        hostRepoPath: "/host",
        worktree: { ...worktree, rounds },
      },
    },
  });
}

it("sheds an older round's decisions, then its findings, then the round, before comments", () => {
  // The comments take the budget above 24 KiB, so the rounds see the
  // pressure they would in a 24 KiB budget.
  const padding = (MAX_CARD_METADATA_BYTES - 24 * 1024) / 5;
  const comments = Array.from({ length: 5 }, (_, index) => ({
    id: `comment-${index}`,
    body: `note ${index} ${"c".repeat(600 + padding)}`,
    createdAt: index,
  }));
  const round0 = fullRound(0);
  const round1 = fullRound(1);
  const round2 = fullRound(2);
  const withoutDecisions = (round: WorkboardNodeRound) => ({
    round: round.round,
    changes: round.changes,
    review: round.review,
  });
  expect(round0.review?.items).toHaveLength(12);

  const twoRounds = trimRounds([round0, round1], comments);
  expect(twoRounds.automation?.target?.worktree?.rounds).toEqual([
    withoutDecisions(round0),
    round1,
  ]);
  expect(twoRounds.comments).toEqual(comments);

  const threeRounds = trimRounds([round0, round1, round2], comments);
  expect(threeRounds.automation?.target?.worktree?.rounds).toEqual([
    withoutDecisions(round1),
    round2,
  ]);
  expect(threeRounds.comments).toEqual(comments);
});

describe("node ticket import diffstat", () => {
  it("reads git diff --numstat -z with binary files and renames", () => {
    // Output of `git diff --numstat -z -M` for a binary add, a rename with an edit, and an add.
    const output = "-\t-\timg.bin\x001\t0\t\0old.txt\0new.txt\x003\t2\ttab.txt\0";

    expect(parseNumstat(output, "from", "to")).toEqual({
      from: "from",
      to: "to",
      files: [
        { path: "tab.txt", added: 3, deleted: 2 },
        { path: "new.txt", previousPath: "old.txt", added: 1, deleted: 0 },
        { path: "img.bin", binary: true },
      ],
      totals: { files: 3, added: 4, deleted: 2 },
    });
    expect(parseNumstat("2\t1\tdocs/a\tb  c.md\0", "from", "to").files).toEqual([
      { path: "docs/a\tb  c.md", added: 2, deleted: 1 },
    ]);
    expect(parseNumstat("", "from", "to")).toEqual({
      from: "from",
      to: "to",
      files: [],
      totals: { files: 0, added: 0, deleted: 0 },
    });
  });

  it("lists the most changed files and still totals every file", () => {
    const output = Array.from({ length: 40 }, (_, index) => `${index}\t1\tsrc/file-${index}.ts`)
      .join("\0")
      .concat("\0");
    const changes = parseNumstat(output, "from", "to");

    expect(changes.files).toHaveLength(30);
    expect(changes.files[0]).toEqual({ path: "src/file-39.ts", added: 39, deleted: 1 });
    expect(changes.totals).toEqual({ files: 40, added: 780, deleted: 40 });
  });
});
