// Workboard tests cover the trust KPI projection's weekly buckets and class grouping.
import type { WorkboardCard, WorkboardNodeWorktree } from "@openclaw/workboard-contract";
import { describe, expect, it } from "vitest";
import { NODE_TARGET } from "./node-ticket.test-support.js";
import { projectWorkboardTrust } from "./trust-kpis.js";

const HOUR = 60 * 60 * 1000;
// Monday 2026-10-05 00:00 UTC.
const MONDAY = Date.UTC(2026, 9, 5);

function ticket(
  id: string,
  params: {
    createdAt: number;
    labels?: string[];
    worktree?: Partial<WorkboardNodeWorktree>;
    blocked?: boolean;
  },
): WorkboardCard {
  return {
    id,
    title: id,
    status: "done",
    priority: "normal",
    labels: params.labels ?? [],
    position: 0,
    createdAt: params.createdAt,
    updatedAt: params.createdAt,
    events: params.blocked
      ? [{ id: `${id}-blocked`, kind: "moved", at: params.createdAt, toStatus: "blocked" }]
      : [],
    metadata: {
      automation: {
        target: {
          ...NODE_TARGET,
          worktree: {
            path: `/wt/${id}`,
            branch: `factory/${id}`,
            baseCommit: "a",
            ...params.worktree,
          },
        },
      },
    },
  };
}

function published(at: number) {
  return {
    handoff: {
      phase: "published" as const,
      headCommit: "b",
      importedAt: at,
      publishedAt: at,
      pullRequestUrl: "https://github.com/acme/app/pull/1",
    },
  };
}

describe("projectWorkboardTrust", () => {
  it("buckets acceptances into UTC Monday weeks with the median lead time", () => {
    const cards = [
      // Sunday night belongs to the week before.
      ticket("prev", { createdAt: MONDAY - 5 * HOUR, worktree: published(MONDAY - 1) }),
      ticket("a", { createdAt: MONDAY, worktree: published(MONDAY + 2 * HOUR) }),
      ticket("b", { createdAt: MONDAY, worktree: published(MONDAY + 4 * HOUR), blocked: true }),
      ticket("open", { createdAt: MONDAY }),
      { ...ticket("plain", { createdAt: MONDAY }), metadata: {} },
    ];

    const trust = projectWorkboardTrust(cards, "app", MONDAY + 24 * HOUR);

    expect(trust.weeks).toHaveLength(8);
    expect(trust.weeks.at(-1)).toEqual({
      weekStart: MONDAY,
      accepted: 2,
      autonomous: 1,
      medianLeadTimeMs: 3 * HOUR,
    });
    expect(trust.weeks.at(-2)).toMatchObject({ accepted: 1, medianLeadTimeMs: 5 * HOUR - 1 });
    expect(trust.total).toMatchObject({ tickets: 4, accepted: 3, blocked: 1, firstPass: 2 });
  });

  it("groups by class label and keeps rework out of clean acceptance", () => {
    const cards = [
      ticket("docs", { createdAt: MONDAY, labels: ["class:docs"], worktree: published(MONDAY) }),
      ticket("rework", {
        createdAt: MONDAY,
        labels: ["class:docs"],
        worktree: {
          ...published(MONDAY),
          rework: {
            round: 2,
            pullRequestUrl: "https://github.com/acme/app/pull/1",
            acceptedAt: MONDAY,
            outsideCommits: 1,
          },
        },
      }),
      ticket("dead", { createdAt: MONDAY, labels: ["class:dead-code"] }),
    ];

    const trust = projectWorkboardTrust(cards, "app", MONDAY);

    expect(trust.classes).toEqual([
      expect.objectContaining({ taskClass: "dead-code", tickets: 1, accepted: 0 }),
      expect.objectContaining({
        taskClass: "docs",
        tickets: 2,
        accepted: 2,
        cleanAccepted: 1,
        reworkRounds: 2,
        outsideCommits: 1,
      }),
    ]);
  });

  it("counts a question an operator answered as a human touch, one an agent answered not", () => {
    const answered = (operatorAnswers: number) => ({
      ...published(MONDAY),
      questions: { rounds: 1, operatorAnswers },
    });
    const cards = [
      ticket("agent", { createdAt: MONDAY, worktree: answered(0) }),
      ticket("operator", { createdAt: MONDAY, worktree: answered(1) }),
    ];

    const trust = projectWorkboardTrust(cards, "app", MONDAY);

    expect(trust.total).toMatchObject({
      accepted: 2,
      cleanAccepted: 1,
      blocked: 0,
      questionRounds: 2,
      operatorAnswers: 1,
    });
    expect(trust.weeks.at(-1)).toMatchObject({ accepted: 2, autonomous: 1 });
  });

  it("scores each verdict against whether the operator reworked that publish", () => {
    const at = MONDAY + HOUR;
    const reworked = { round: 1, pullRequestUrl: "u", acceptedAt: at, outsideCommits: 0 };
    const cards = [
      // Accepted after the first publish, then reworked: the accept verdict missed it.
      ticket("reopened", {
        createdAt: MONDAY,
        worktree: {
          ...published(at),
          rework: reworked,
          reviews: [
            { round: 0, verdict: "accept" },
            { round: 1, verdict: "accept" },
          ],
        },
      }),
      ticket("agreed", {
        createdAt: MONDAY,
        worktree: { ...published(at), reviews: [{ round: 0, verdict: "accept" }] },
      }),
      ticket("late", {
        createdAt: MONDAY,
        worktree: { ...published(at), reviews: [{ round: 0, verdict: "missed" }] },
      }),
    ];

    expect(projectWorkboardTrust(cards, "app", MONDAY).total).toMatchObject({
      verdictRounds: 3,
      verdictAgreedRounds: 2,
      verdictCards: 2,
      verdictAgreedCards: 1,
      verdictMissed: 1,
    });
  });
});
