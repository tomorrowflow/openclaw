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

  it("reports the median review wait from import to publish per published round", () => {
    const round = (importedAt: number, publishedAt: number) => ({
      verdict: "missed" as const,
      importedAt,
      publishedAt,
    });
    const cards = [
      ticket("a", {
        createdAt: MONDAY,
        worktree: {
          ...published(MONDAY + 3 * HOUR),
          // Recorded before review times existed: no wait to report.
          reviews: [{ round: 0, verdict: "accept" }],
        },
      }),
      ticket("b", {
        createdAt: MONDAY,
        worktree: {
          ...published(MONDAY + 9 * HOUR),
          rework: {
            round: 1,
            pullRequestUrl: "https://github.com/acme/app/pull/2",
            acceptedAt: MONDAY + 3 * HOUR,
            outsideCommits: 0,
          },
          reviews: [
            { round: 0, ...round(MONDAY + HOUR, MONDAY + 3 * HOUR) },
            { round: 1, ...round(MONDAY + 3 * HOUR, MONDAY + 9 * HOUR) },
          ],
        },
      }),
    ];

    const trust = projectWorkboardTrust(cards, "app", MONDAY + 24 * HOUR);

    expect(trust.weeks.at(-1)).toMatchObject({ accepted: 2, medianReviewWaitMs: 4 * HOUR });
    expect(trust.weeks.at(-2)).not.toHaveProperty("medianReviewWaitMs");
  });

  it("counts smart-zone breaches and the weekly median turn-end context per measured run", () => {
    const run = (id: string, endedAt: number, contextTokens?: number) => ({
      id,
      status: "succeeded" as const,
      startedAt: endedAt - HOUR,
      endedAt,
      ...(contextTokens === undefined ? {} : { contextTokens }),
    });
    const card = ticket("a", { createdAt: MONDAY, labels: ["class:server-fix"] });
    card.metadata!.attempts = [
      run("r1", MONDAY + HOUR, 40_000),
      run("r2", MONDAY + 2 * HOUR, 151_000),
      run("r3", MONDAY + 3 * HOUR, 100_000),
      // Recorded before context was measured: neither measured nor a breach.
      run("r4", MONDAY + 4 * HOUR),
      run("old", MONDAY - HOUR, 20_000),
    ];

    const trust = projectWorkboardTrust([card], "app", MONDAY + 24 * HOUR);

    expect(trust.smartZoneTokens).toBe(150_000);
    expect(trust.total).toMatchObject({ attempts: 5, contextMeasured: 4, smartZoneBreaches: 1 });
    expect(trust.classes[0]).toMatchObject({ taskClass: "server-fix", smartZoneBreaches: 1 });
    expect(trust.weeks.at(-1)?.medianContextTokens).toBe(100_000);
    expect(trust.weeks.at(-2)?.medianContextTokens).toBe(20_000);
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

  it("leaves out archived tickets that were never accepted", () => {
    const archived = (card: WorkboardCard): WorkboardCard => ({
      ...card,
      metadata: { ...card.metadata, archivedAt: MONDAY },
    });
    const cards = [
      ticket("shipped", { createdAt: MONDAY, worktree: published(MONDAY + HOUR) }),
      // Archiving a shipped ticket tidies the board; its acceptance stays history.
      archived(ticket("tidied", { createdAt: MONDAY, worktree: published(MONDAY + 3 * HOUR) })),
      // Archive closes a ticket without a PR, so it is no outcome to score.
      archived(ticket("dropped", { createdAt: MONDAY })),
      archived(ticket("duplicate", { createdAt: MONDAY, blocked: true })),
    ];

    const trust = projectWorkboardTrust(cards, "app", MONDAY + 24 * HOUR);

    expect(trust.total).toMatchObject({ tickets: 2, accepted: 2, blocked: 0 });
    expect(trust.weeks.at(-1)).toMatchObject({ accepted: 2, medianLeadTimeMs: 2 * HOUR });
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

  it("leaves rework rounds that added no commit besides merges out of rework and disagreement", () => {
    const at = MONDAY + HOUR;
    const rework = { pullRequestUrl: "u", acceptedAt: at, outsideCommits: 0, unchangedRounds: [1] };
    const accept = (round: number) => ({ round, verdict: "accept" as const });
    const cards = [
      // Round 1 only merged main to clear a conflict: the round 0 accept held.
      ticket("merged", {
        createdAt: MONDAY,
        worktree: { ...published(at), rework: { ...rework, round: 1 }, reviews: [accept(0)] },
      }),
      // Round 2 changed code, so the accepts on rounds 0 and 1 were both reworked.
      ticket("changed", {
        createdAt: MONDAY,
        worktree: {
          ...published(at),
          rework: { ...rework, round: 2 },
          reviews: [accept(0), accept(1), accept(2)],
        },
      }),
    ];

    expect(projectWorkboardTrust(cards, "app", MONDAY).total).toMatchObject({
      accepted: 2,
      cleanAccepted: 1,
      reworkRounds: 1,
      verdictRounds: 4,
      verdictAgreedRounds: 2,
      verdictAgreedCards: 1,
    });
  });

  it("scores agent acceptances at rung b apart from shadow verdicts, with the sample and the board's rung", () => {
    const at = MONDAY + HOUR;
    const reworked = { round: 1, pullRequestUrl: "u", acceptedAt: at, outsideCommits: 0 };
    const cards = [
      // The sampled round 0 accept was reworked by its reader; round 1 held.
      ticket("reopened", {
        createdAt: MONDAY,
        labels: ["class:docs"],
        worktree: {
          ...published(at),
          rework: reworked,
          reviews: [
            { round: 0, verdict: "accept", decidedBy: "agent", sampled: true },
            { round: 1, verdict: "accept", decidedBy: "agent", sampled: true },
          ],
        },
      }),
      ticket("unread", {
        createdAt: MONDAY,
        labels: ["class:docs"],
        worktree: {
          ...published(at),
          reviews: [{ round: 0, verdict: "accept", decidedBy: "agent", sampled: false }],
        },
      }),
      ticket("shadow", {
        createdAt: MONDAY,
        labels: ["class:server"],
        worktree: { ...published(at), reviews: [{ round: 0, verdict: "accept" }] },
      }),
    ];

    const trust = projectWorkboardTrust(cards, "app", MONDAY, {
      classRungs: { docs: { rung: "b" } },
    });

    expect(trust.total).toMatchObject({
      verdictRounds: 1,
      verdictAgreedRounds: 1,
      verdictCards: 1,
      agentAccepts: 3,
      reworkedAccepts: 1,
      sampledRounds: 2,
      sampledAgreed: 1,
    });
    expect(
      trust.classes.map(({ taskClass, rung, agentAccepts }) => ({ taskClass, rung, agentAccepts })),
    ).toEqual([
      { taskClass: "docs", rung: "b", agentAccepts: 3 },
      { taskClass: "server", rung: "a", agentAccepts: 0 },
    ]);
    expect(projectWorkboardTrust(cards, "all", MONDAY).classes[0]).not.toHaveProperty("rung");
  });

  it("counts blind rounds by the rung that decided them, leaving out rounds the operator saw", () => {
    const blindSince = Date.parse("2026-10-11T13:01:00+02:00");
    const before = blindSince - HOUR;
    const after = blindSince + HOUR;
    const cards = [
      ticket("seen", {
        createdAt: before,
        labels: ["class:docs"],
        worktree: {
          ...published(before),
          reviews: [{ round: 0, verdict: "accept", publishedAt: before }],
        },
      }),
      ticket("operator", {
        createdAt: before,
        labels: ["class:docs"],
        worktree: {
          ...published(after),
          reviews: [{ round: 0, verdict: "accept", publishedAt: after }],
        },
      }),
      // Accepted by the agent at rung b, then demoted: the operator decided round 1 at rung a.
      ticket("demoted", {
        createdAt: before,
        labels: ["class:docs"],
        worktree: {
          ...published(after),
          rework: { round: 1, pullRequestUrl: "u", acceptedAt: after, outsideCommits: 0 },
          reviews: [
            { round: 0, verdict: "accept", decidedBy: "agent", sampled: true, publishedAt: after },
            { round: 1, verdict: "missed", publishedAt: after + HOUR },
          ],
        },
      }),
    ];

    const [docs] = projectWorkboardTrust(cards, "app", after).classes;

    expect(docs).toMatchObject({ tickets: 3, accepted: 3, verdictRounds: 2 });
    expect(docs?.blind.a).toMatchObject({
      tickets: 2,
      accepted: 1,
      cleanAccepted: 1,
      verdictRounds: 1,
      verdictAgreedRounds: 1,
      verdictMissed: 1,
      verdictMissedRecent: 1,
      agentAccepts: 0,
    });
    expect(docs?.blind.b).toMatchObject({
      tickets: 1,
      accepted: 1,
      cleanAccepted: 0,
      verdictRounds: 0,
      agentAccepts: 1,
      reworkedAccepts: 1,
      sampledRounds: 1,
    });
  });

  it("counts missed verdicts among the newest 10 operator rounds by publish time", () => {
    const round = (id: string, verdict: "accept" | "missed", publishedAt?: number) =>
      ticket(id, {
        createdAt: MONDAY,
        worktree: {
          ...published(MONDAY),
          reviews: [{ round: 0, verdict, ...(publishedAt === undefined ? {} : { publishedAt }) }],
        },
      });
    const older = [
      round("unrecorded", "missed"),
      round("oldest", "missed", MONDAY),
      ...Array.from({ length: 10 }, (_, index) =>
        round(`newer-${index}`, "accept", MONDAY + (index + 1) * HOUR),
      ),
    ];

    expect(projectWorkboardTrust(older, "app", MONDAY).total).toMatchObject({
      verdictMissed: 2,
      verdictMissedRecent: 0,
    });
    const latest = [...older, round("latest", "missed", MONDAY + 20 * HOUR)];
    expect(projectWorkboardTrust(latest, "app", MONDAY).total).toMatchObject({
      verdictMissed: 3,
      verdictMissedRecent: 1,
    });
  });
});
