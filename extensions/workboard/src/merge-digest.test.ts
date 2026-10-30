// Workboard tests cover the digest of PRs merged at rung c, per class, with a revert command each.
import type { WorkboardCard, WorkboardNodeReviewVerdict } from "@openclaw/workboard-contract";
import { describe, expect, it } from "vitest";
import { projectWorkboardMergeDigest } from "./merge-digest.js";

const HOUR = 60 * 60_000;
const NOW = Date.parse("2026-10-30T12:00:00Z");

function mergedCard(
  number: number,
  taskClass: string,
  merged: { at: number; autoMerged?: true; regression?: true },
  review: Partial<WorkboardNodeReviewVerdict>,
): WorkboardCard {
  const url = `https://github.com/acme/app/pull/${number}`;
  return {
    id: `card-${number}`,
    title: `PR ${number}`,
    status: "done",
    priority: "normal",
    labels: [`class:${taskClass}`],
    position: 0,
    createdAt: 0,
    updatedAt: 0,
    metadata: {
      automation: {
        target: {
          kind: "node-claude",
          nodeId: "node",
          repoPath: "/repo",
          worktreesRoot: "/wt",
          hostRepoPath: "/host",
          worktree: {
            path: `/wt/${number}`,
            branch: `factory/${number}`,
            baseCommit: "a",
            handoff: {
              phase: "published",
              headCommit: "h",
              importedAt: 0,
              publishedAt: 0,
              pullRequestUrl: url,
              pullRequest: {
                state: "merged",
                checkedAt: merged.at,
                mergedAt: merged.at,
                mergeCommit: `${number}`.padEnd(40, "0"),
                ...(merged.autoMerged ? { autoMerged: true } : {}),
                ...(merged.regression
                  ? { regression: { kind: "revert", at: merged.at, commit: "r".repeat(40) } }
                  : {}),
              },
            },
            reviews: [
              { round: 0, verdict: "rework", decidedBy: "agent", rung: "c" },
              { round: 1, verdict: "accept", decidedBy: "agent", rung: "c", ...review },
            ],
          },
        },
      },
    },
  } satisfies WorkboardCard;
}

/** The card with its last round decided by the operator instead. */
function operatorRound(card: WorkboardCard): WorkboardCard {
  const last = card.metadata?.automation?.target?.worktree?.reviews?.at(-1);
  delete last?.decidedBy;
  return card;
}

describe("projectWorkboardMergeDigest", () => {
  it("lists the window's merges of rung c agent accepts per class, oldest first, with a revert command", () => {
    const cards = [
      mergedCard(12, "ios-logic", { at: NOW - 1 * HOUR, autoMerged: true }, {}),
      mergedCard(11, "ios-logic", { at: NOW - 3 * HOUR, regression: true }, { sampled: true }),
      mergedCard(10, "docs", { at: NOW - 2 * HOUR, autoMerged: true }, {}),
      // Before the window, accepted at b, and an operator's round: left out.
      mergedCard(9, "docs", { at: NOW - 30 * HOUR, autoMerged: true }, {}),
      mergedCard(8, "docs", { at: NOW - 2 * HOUR }, { rung: "b" }),
      operatorRound(mergedCard(7, "docs", { at: NOW - 2 * HOUR }, {})),
    ];

    const digest = projectWorkboardMergeDigest(cards, "default", NOW - 24 * HOUR, NOW);

    expect(
      digest.classes.map(({ taskClass, merges }) => [taskClass, merges.map((m) => m.cardId)]),
    ).toEqual([
      ["docs", ["card-10"]],
      ["ios-logic", ["card-11", "card-12"]],
    ]);
    expect(digest.classes[1]?.merges[0]).toMatchObject({
      repo: "acme/app",
      pullRequestUrl: "https://github.com/acme/app/pull/11",
      autoMerged: false,
      sampled: true,
      revertCommand: `git revert -m 1 ${"11".padEnd(40, "0")}`,
    });
    expect(digest.text).toBe(
      [
        "**Merged at rung c** since 2026-10-29 12:00 UTC: 3 PRs",
        "",
        "**docs**",
        "- [#10](https://github.com/acme/app/pull/10) PR 10: auto-merged 2026-10-30 10:00 UTC as 1000000",
        `  Revert in acme/app: \`git revert -m 1 ${"10".padEnd(40, "0")}\``,
        "",
        "**ios-logic**",
        "- [#11](https://github.com/acme/app/pull/11) PR 11: merged by hand 2026-10-30 09:00 UTC as 1100000 (sampled, unread; regressed: reverted by rrrrrrr)",
        `  Revert in acme/app: \`git revert -m 1 ${"11".padEnd(40, "0")}\``,
        "- [#12](https://github.com/acme/app/pull/12) PR 12: auto-merged 2026-10-30 11:00 UTC as 1200000",
        `  Revert in acme/app: \`git revert -m 1 ${"12".padEnd(40, "0")}\``,
      ].join("\n"),
    );
  });

  it("says so when nothing merged at rung c", () => {
    expect(projectWorkboardMergeDigest([], "default", NOW - 24 * HOUR, NOW).text).toBe(
      "Nothing merged at rung c since 2026-10-29 12:00 UTC.",
    );
  });
});
