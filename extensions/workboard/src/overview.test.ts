import type {
  WorkboardBoardSummary,
  WorkboardCard,
  WorkboardNodeWorktree,
} from "@openclaw/workboard-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { redactOperatorCard } from "./card-redaction.js";
import { NODE_TARGET } from "./node-ticket.test-support.js";
import { projectWorkboardOverview } from "./overview.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 14, 12);
const PR = "https://github.com/acme/app/pull/7";

type CardInput = Partial<Omit<WorkboardCard, "metadata">> & {
  boardId?: string;
  summary?: string;
  archivedAt?: number;
  worktree?: Partial<WorkboardNodeWorktree>;
  node?: boolean;
  metadata?: WorkboardCard["metadata"];
};

function card(id: string, input: CardInput = {}): WorkboardCard {
  const { boardId, summary, archivedAt, worktree, node, metadata, ...fields } = input;
  const target =
    node || worktree
      ? {
          ...NODE_TARGET,
          ...(worktree
            ? {
                worktree: {
                  path: `/wt/${id}`,
                  branch: `factory/${id}`,
                  baseCommit: "a",
                  ...worktree,
                },
              }
            : {}),
        }
      : undefined;
  return {
    id,
    title: id,
    status: "todo",
    priority: "normal",
    labels: [],
    position: 0,
    createdAt: NOW - DAY,
    updatedAt: NOW - DAY,
    ...fields,
    metadata: {
      ...metadata,
      ...(archivedAt ? { archivedAt } : {}),
      automation: {
        ...metadata?.automation,
        ...(boardId ? { boardId } : {}),
        ...(summary ? { summary } : {}),
        ...(target ? { target } : {}),
      },
    },
  };
}

function board(id: string, extra: Partial<WorkboardBoardSummary> = {}): WorkboardBoardSummary {
  return { id, total: 0, active: 0, archived: 0, byStatus: {}, ...extra };
}

function imported(at: number): Partial<WorkboardNodeWorktree> {
  return { handoff: { phase: "imported", headCommit: "b", importedAt: at } };
}

function published(at: number, review: NonNullable<WorkboardNodeWorktree["reviews"]>[number]) {
  return {
    handoff: {
      phase: "published" as const,
      headCommit: "b",
      importedAt: at - HOUR,
      publishedAt: at,
      pullRequestUrl: PR,
    },
    reviews: [review],
  };
}

function overview(cards: WorkboardCard[], boards = [board("default")]) {
  return projectWorkboardOverview(cards.map(redactOperatorCard), boards, "all", NOW);
}

const rungB = board("default", {
  automationJobId: "job-1",
  orchestration: { classRungs: { docs: { rung: "b" } } },
});

const VERDICT = {
  id: "verdict",
  body: "Verdict: accept",
  createdAt: NOW,
  source: "agent:dev",
} as const;

describe("projectWorkboardOverview", () => {
  // The stage reads the clock for the review deadline.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks the operator to decide a rung a review without leaking the agent's pending verdict", () => {
    const pending = card("pending", {
      status: "review",
      summary: "Fix the parser crash on empty input.",
      worktree: imported(NOW - 2 * HOUR),
      metadata: {
        comments: [
          {
            id: "c1",
            body: "Verdict: rework: the fix skips the empty-array case",
            createdAt: NOW - HOUR,
            source: "agent:dev",
          },
        ],
      },
    });

    const result = overview([pending]);

    expect(result.needsYou).toEqual([
      {
        cardId: "pending",
        boardId: "default",
        title: "pending",
        summary: "Fix the parser crash on empty input.",
        // The wait starts at the verdict's arrival, not the import.
        stage: { kind: "awaiting_review", since: NOW - HOUR },
        reason: "decide",
        waitingSince: NOW - HOUR,
      },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/verdict|rework: the fix/i);
  });

  it("leaves a rung b review to the agent unless its class was demoted or no automation job reviews it", () => {
    const labels = ["class:docs"];
    const cards = [
      card("agent-review", {
        status: "review",
        labels,
        worktree: { ...imported(NOW), rung: "b" },
        metadata: { comments: [VERDICT] },
      }),
    ];

    expect(overview(cards, [rungB])).toMatchObject({
      needsYou: [],
      inFlight: [{ cardId: "agent-review", nodeId: NODE_TARGET.nodeId, round: 0 }],
    });
    for (const decidedByOperator of [
      board("default", { automationJobId: "job-1" }),
      { ...rungB, automationJobId: undefined },
    ]) {
      expect(overview(cards, [decidedByOperator])).toMatchObject({
        needsYou: [{ cardId: "agent-review", reason: "decide" }],
        inFlight: [],
      });
    }
  });

  it("keeps a round in flight until its verdict lands, then asks the operator, or after the deadline for a decision anyway", () => {
    const withVerdict = card("posted", {
      status: "review",
      worktree: imported(NOW - HOUR),
      metadata: { comments: [{ ...VERDICT, createdAt: NOW - HOUR + 1 }] },
    });
    const waiting = card("waiting", { status: "review", worktree: imported(NOW - 60_000) });
    const overdue = card("overdue", { status: "review", worktree: imported(NOW - HOUR) });

    const result = overview([withVerdict, waiting, overdue]);

    expect(result.inFlight).toEqual([expect.objectContaining({ cardId: "waiting" })]);
    // Longest wait first: the posted round waits from its verdict, after the overdue import.
    expect(result.needsYou).toEqual([
      expect.objectContaining({
        cardId: "overdue",
        stage: { kind: "review_incomplete", since: NOW - HOUR, missing: ["verdict"] },
      }),
      expect.objectContaining({
        cardId: "posted",
        stage: { kind: "awaiting_review", since: NOW - HOUR + 1 },
      }),
    ]);
  });

  it("shows a sampled agent-accepted PR as waiting for a read until marked read, and an unsampled one only as shipped", () => {
    const accept = { round: 0, verdict: "accept" as const, decidedBy: "agent" as const };
    const result = overview([
      card("sampled", {
        status: "done",
        worktree: published(NOW - DAY, { ...accept, sampled: true }),
      }),
      card("unsampled", {
        status: "done",
        worktree: published(NOW - 2 * DAY, { ...accept, sampled: false }),
      }),
      card("read", {
        status: "done",
        worktree: published(NOW - 3 * DAY, { ...accept, sampled: true, readAt: NOW - HOUR }),
      }),
    ]);

    expect(result.needsYou).toEqual([
      expect.objectContaining({ cardId: "sampled", reason: "sampled", waitingSince: NOW - DAY }),
    ]);
    expect(result.shipped).toEqual([
      expect.objectContaining({
        cardId: "sampled",
        pullRequestUrl: PR,
        rounds: 1,
        decidedBy: "agent",
        sampled: true,
      }),
      expect.objectContaining({ cardId: "unsampled", decidedBy: "agent", sampled: false }),
      expect.objectContaining({ cardId: "read", sampled: true }),
    ]);
    expect(result.shipped[0]).not.toHaveProperty("shadowVerdict");
  });

  it("keeps a draft an agent published to rework in flight until it reopens", () => {
    const result = overview([
      card("agent-rework", {
        status: "done",
        worktree: published(NOW - HOUR, { round: 0, verdict: "rework", decidedBy: "agent" }),
      }),
    ]);

    expect(result.shipped).toEqual([]);
    expect(result.needsYou).toEqual([]);
    expect(result.inFlight).toEqual([
      expect.objectContaining({
        cardId: "agent-rework",
        stage: expect.objectContaining({ kind: "published" }),
      }),
    ]);
  });

  it("puts escalated questions, and questions no automation job answers, in front of the operator", () => {
    const questions = (escalatedAt?: number) => ({
      handoff: {
        phase: "questions" as const,
        askedAt: NOW - 3 * HOUR,
        ...(escalatedAt === undefined ? {} : { escalatedAt }),
      },
    });
    const cards = [
      card("escalated", { status: "review", worktree: questions(NOW - HOUR) }),
      card("open-question", { status: "review", worktree: questions() }),
    ];

    expect(overview(cards, [board("default", { automationJobId: "job-1" })])).toMatchObject({
      needsYou: [{ cardId: "escalated", reason: "questions", waitingSince: NOW - HOUR }],
      inFlight: [{ cardId: "open-question" }],
    });
    expect(overview(cards).needsYou.map((row) => row.cardId)).toEqual([
      "open-question",
      "escalated",
    ]);
  });

  it("lists running and queued work with its node, round, and last context", () => {
    const result = overview([
      card("running", {
        status: "running",
        worktree: {
          rework: { round: 2, pullRequestUrl: PR, acceptedAt: NOW - DAY, outsideCommits: 0 },
        },
        metadata: {
          attempts: [
            { id: "a1", status: "failed", startedAt: NOW - 3 * HOUR, contextTokens: 90_000 },
            { id: "a2", status: "running", startedAt: NOW - HOUR },
          ],
        },
      }),
      card("queued", {
        node: true,
        metadata: { automation: { startRequest: { requestedAt: NOW - 2 * HOUR } } },
      }),
      card("plain-running", { status: "running" }),
    ]);

    expect(result.inFlight).toEqual([
      expect.objectContaining({ cardId: "plain-running", stage: { kind: "running" } }),
      expect.objectContaining({
        cardId: "queued",
        stage: { kind: "queued", since: NOW - 2 * HOUR },
        round: 0,
      }),
      expect.objectContaining({
        cardId: "running",
        nodeId: NODE_TARGET.nodeId,
        round: 2,
        contextTokens: 90_000,
      }),
    ]);
    expect(result.inFlight[0]).not.toHaveProperty("nodeId");
  });

  it("leaves probes out of what waits on the operator, showing one only while it runs or verifies", () => {
    const probe = { automation: { probe: { of: "source", arm: "base", createdAt: NOW - DAY } } };
    const result = overview([
      card("blocked-probe", { status: "blocked", node: true, metadata: probe }),
      card("asking-probe", {
        status: "review",
        worktree: { handoff: { phase: "questions", askedAt: NOW - HOUR } },
        metadata: probe,
      }),
      card("verifying-probe", {
        status: "review",
        worktree: imported(NOW - HOUR),
        metadata: probe,
      }),
      card("running-probe", { status: "running", node: true, metadata: probe }),
    ]);

    expect(result.needsYou).toEqual([]);
    expect(result.inFlight.map((row) => row.cardId)).toEqual(["running-probe", "verifying-probe"]);
  });

  it("ships only the last 7 days, with the shadow verdict on a round the operator accepted", () => {
    const result = overview([
      card("this-week", {
        status: "done",
        worktree: published(NOW - 6 * DAY, { round: 0, verdict: "accept" }),
      }),
      card("last-week", {
        status: "done",
        worktree: published(NOW - 8 * DAY, { round: 0, verdict: "accept" }),
      }),
      card("plain-done", { status: "done", completedAt: NOW - HOUR }),
      card("old-done", { status: "done", completedAt: NOW - 9 * DAY }),
    ]);

    expect(result.shipped).toEqual([
      {
        cardId: "plain-done",
        boardId: "default",
        title: "plain-done",
        stage: { kind: "done", since: NOW - HOUR },
        shippedAt: NOW - HOUR,
      },
      expect.objectContaining({
        cardId: "this-week",
        shippedAt: NOW - 6 * DAY,
        decidedBy: "operator",
        shadowVerdict: "accept",
      }),
    ]);
  });

  it("collects gardener and architecture insights from the open backlog", () => {
    const result = overview([
      card("gardener", { status: "backlog", labels: ["gardener"], createdAt: NOW - 2 * DAY }),
      card("architecture", { status: "backlog", labels: ["architecture"], createdAt: NOW - DAY }),
      card("started", { status: "todo", labels: ["gardener"] }),
      card("unlabeled", { status: "backlog" }),
    ]);

    expect(result.insights).toEqual([
      expect.objectContaining({ cardId: "architecture", label: "architecture" }),
      expect.objectContaining({ cardId: "gardener", label: "gardener", createdAt: NOW - 2 * DAY }),
    ]);
  });

  it("leaves archived cards and cards on archived boards out of every band and count", () => {
    const result = overview(
      [
        card("blocked", { status: "blocked" }),
        card("archived", { status: "blocked", archivedAt: NOW - HOUR }),
        card("old-board", { status: "blocked", boardId: "old" }),
        card("backlog", { status: "backlog" }),
        card("done", { status: "done", completedAt: NOW - HOUR }),
      ],
      [board("default"), board("old", { archivedAt: NOW - DAY })],
    );

    expect(result.needsYou.map((row) => row.cardId)).toEqual(["blocked"]);
    expect(result.open).toEqual({ blocked: 1, backlog: 1 });
    expect(result.week).toMatchObject({ accepted: 0, autonomous: 0 });
  });
});
