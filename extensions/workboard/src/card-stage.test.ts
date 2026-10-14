import type {
  WorkboardCard,
  WorkboardMetadata,
  WorkboardNodeWorktree,
} from "@openclaw/workboard-contract";
import { describe, expect, it } from "vitest";
import { workboardCardStage } from "./card-stage.js";

function card(
  status: WorkboardCard["status"],
  metadata: WorkboardMetadata = {},
  extra: Partial<WorkboardCard> = {},
): WorkboardCard {
  return {
    id: "card-1",
    title: "Parser crash",
    status,
    priority: "normal",
    labels: [],
    position: 1,
    createdAt: 1,
    updatedAt: 1,
    metadata,
    ...extra,
  };
}

function nodeTicket(worktree?: Partial<WorkboardNodeWorktree>): WorkboardMetadata {
  return {
    automation: {
      target: {
        kind: "node-claude",
        nodeId: "mac-node",
        repoPath: "/repo",
        worktreesRoot: "/wt",
        hostRepoPath: "/host",
        ...(worktree
          ? {
              worktree: {
                path: "/wt/wb-card-1",
                branch: "factory/card-1",
                baseCommit: "a".repeat(40),
                ...worktree,
              },
            }
          : {}),
      },
    },
  };
}

const pr = "https://github.com/acme/app/pull/7";

describe("workboardCardStage", () => {
  it.each([
    { name: "an idle backlog card", card: card("backlog"), stage: undefined },
    {
      name: "an archived card",
      card: card("blocked", { archivedAt: 5 }),
      stage: undefined,
    },
    {
      name: "a start queued for a node slot",
      card: card("todo", {
        automation: { ...nodeTicket().automation, startRequest: { requestedAt: 40 } },
      }),
      stage: { kind: "queued", since: 40 },
    },
    {
      name: "a node rework round on its second attempt",
      card: card("running", {
        ...nodeTicket({
          rework: { round: 2, pullRequestUrl: pr, acceptedAt: 10, outsideCommits: 0 },
          feedback: { kind: "rework", from: 20 },
        }),
        attempts: [
          { id: "a1", status: "failed", startedAt: 30, endedAt: 31 },
          { id: "a2", status: "running", startedAt: 50 },
        ],
      }),
      stage: { kind: "running", since: 50, nodeId: "mac-node", reworkRound: 2, attempt: 2 },
    },
    {
      name: "an answer round after an earlier rework",
      card: card("running", {
        ...nodeTicket({
          rework: { round: 1, pullRequestUrl: pr, acceptedAt: 10, outsideCommits: 0 },
          feedback: { kind: "answer", from: 20 },
        }),
      }),
      stage: { kind: "running", nodeId: "mac-node" },
    },
    {
      name: "a plain card running since its move",
      card: card(
        "running",
        {},
        { events: [{ id: "e", kind: "moved", at: 60, toStatus: "running" }] },
      ),
      stage: { kind: "running", since: 60 },
    },
    {
      name: "escalated questions",
      card: card(
        "review",
        nodeTicket({ handoff: { phase: "questions", askedAt: 70, escalatedAt: 75 } }),
      ),
      stage: { kind: "questions", since: 70, escalatedAt: 75 },
    },
    {
      name: "an imported round waiting for the operator",
      card: card(
        "review",
        nodeTicket({ handoff: { phase: "imported", headCommit: "b".repeat(40), importedAt: 80 } }),
      ),
      stage: { kind: "awaiting_review", since: 80 },
    },
    {
      name: "an agent-accepted round being published",
      card: card(
        "done",
        nodeTicket({
          handoff: {
            phase: "imported",
            headCommit: "b".repeat(40),
            importedAt: 80,
            decidedBy: "agent:dev",
            sampled: true,
          },
        }),
        { completedAt: 85 },
      ),
      stage: { kind: "done", since: 85 },
    },
    {
      name: "a published rework round",
      card: card(
        "done",
        nodeTicket({
          rework: { round: 1, pullRequestUrl: pr, acceptedAt: 10, outsideCommits: 0 },
          handoff: {
            phase: "published",
            headCommit: "b".repeat(40),
            importedAt: 80,
            publishedAt: 90,
            pullRequestUrl: pr,
          },
        }),
      ),
      stage: { kind: "published", since: 90, pullRequestUrl: pr, reworkRound: 1 },
    },
    {
      name: "a blocked published ticket",
      card: card(
        "blocked",
        nodeTicket({
          handoff: {
            phase: "published",
            headCommit: "b".repeat(40),
            importedAt: 80,
            publishedAt: 90,
            pullRequestUrl: pr,
          },
        }),
        { events: [{ id: "e", kind: "moved", at: 95, toStatus: "blocked" }] },
      ),
      stage: { kind: "blocked", since: 95 },
    },
    {
      name: "a published ticket reopened to backlog",
      card: card(
        "backlog",
        nodeTicket({
          handoff: {
            phase: "published",
            headCommit: "b".repeat(40),
            importedAt: 80,
            publishedAt: 90,
            pullRequestUrl: pr,
          },
        }),
      ),
      stage: undefined,
    },
    {
      name: "a done ticket whose questions went unanswered",
      card: card("done", nodeTicket({ handoff: { phase: "questions", askedAt: 70 } }), {
        completedAt: 99,
      }),
      stage: { kind: "done", since: 99 },
    },
    {
      name: "a plain card in review whose move aged out of the events",
      card: card("review"),
      stage: { kind: "review" },
    },
  ])("derives $name", ({ card: input, stage }) => {
    expect(workboardCardStage(input)).toEqual(stage);
  });
});
