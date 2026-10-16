import type { WorkboardCard } from "@openclaw/workboard-contract";
import { describe, expect, it } from "vitest";
import { HIDDEN_VERDICT_NOTICE, redactClaimToken, redactOperatorCard } from "./card-redaction.js";

type NodeTarget = NonNullable<
  NonNullable<NonNullable<WorkboardCard["metadata"]>["automation"]>["target"]
>;

function createCard(metadata?: WorkboardCard["metadata"]): WorkboardCard {
  return {
    id: "card-1",
    title: "Ship cleanup",
    status: "running",
    priority: "normal",
    labels: ["cleanup"],
    position: 1,
    createdAt: 1,
    updatedAt: 1,
    metadata,
  };
}

describe("redactClaimToken", () => {
  it("preserves card identity when there is no claim", () => {
    const card = createCard({ archivedAt: 1 });

    expect(redactClaimToken(card)).toBe(card);
  });

  it("redacts the token without mutating the card", () => {
    const card = createCard({
      claim: {
        ownerId: "worker",
        token: "secret-token",
        claimedAt: 1,
        lastHeartbeatAt: 2,
      },
    });

    const redacted = redactClaimToken(card);

    expect(redacted).not.toBe(card);
    expect(redacted.labels).toBe(card.labels);
    expect(redacted.metadata).not.toBe(card.metadata);
    expect(redacted.metadata?.claim).not.toBe(card.metadata?.claim);
    expect(redacted.metadata?.claim?.token).toBe("[redacted]");
    expect(card.metadata?.claim?.token).toBe("secret-token");
  });
});

describe("redactOperatorCard", () => {
  it("replaces plain and Markdown-emphasized agent verdicts on an undecided review with a notice", () => {
    const comment = (body: string, source?: "operator" | "agent:dev") => ({
      id: body,
      body,
      createdAt: 20,
      ...(source ? { source } : {}),
    });
    const card: WorkboardCard = {
      ...createCard({
        automation: {
          target: {
            kind: "node-claude",
            nodeId: "node",
            repoPath: "/repo",
            worktreesRoot: "/wt",
            hostRepoPath: "/host",
            worktree: {
              path: "/wt/wb-card-1",
              branch: "factory/card-1",
              baseCommit: "a".repeat(40),
              handoff: { phase: "imported", headCommit: "b".repeat(40), importedAt: 10 },
            },
          },
        },
        comments: [
          comment("Verdict: accept", "agent:dev"),
          comment("**Verdict:** accept", "agent:dev"),
          comment("**Verdict**: rework: no test", "agent:dev"),
          comment("**Verdict: rework**: no test", "agent:dev"),
          comment("__Verdict:__ accept", "agent:dev"),
          comment("__Verdict: rework__: no test", "agent:dev"),
          comment("Verdict: **accept**", "agent:dev"),
          comment("My verdict: accept, once the test lands.", "agent:dev"),
          comment("**Verdict pending** until CI is green.", "agent:dev"),
          comment("Verdict: accept", "operator"),
        ],
      }),
      status: "review",
    };

    const hidden = HIDDEN_VERDICT_NOTICE;
    expect(redactOperatorCard(card).metadata?.comments?.map((entry) => entry.body)).toEqual([
      hidden,
      hidden,
      hidden,
      hidden,
      hidden,
      hidden,
      hidden,
      "My verdict: accept, once the test lands.",
      "**Verdict pending** until CI is green.",
      "Verdict: accept",
    ]);
  });

  it("carries a node ticket's rounds beside the card while a pending verdict stays hidden", () => {
    const rounds = [
      {
        round: 0,
        decisions: [{ phase: "plan", decision: "Return [] for empty input" }],
        changes: {
          from: "a".repeat(40),
          to: "b".repeat(40),
          files: [{ path: "parser.py", added: 3, deleted: 1 }],
          totals: { files: 1, added: 3, deleted: 1 },
        },
      },
    ];
    const card: WorkboardCard = {
      ...createCard({
        automation: {
          target: {
            kind: "node-claude",
            nodeId: "node",
            repoPath: "/repo",
            worktreesRoot: "/wt",
            hostRepoPath: "/host",
            worktree: {
              path: "/wt/wb-card-1",
              branch: "factory/card-1",
              baseCommit: "a".repeat(40),
              handoff: { phase: "imported", headCommit: "b".repeat(40), importedAt: 10 },
              rounds,
            },
          },
        },
        comments: [{ id: "verdict", body: "Verdict: accept", createdAt: 20, source: "agent:dev" }],
      }),
      status: "review",
    };

    const operatorCard = redactOperatorCard(card);

    expect(operatorCard.rounds).toEqual(rounds);
    expect(operatorCard.metadata?.comments).toEqual([
      { id: "verdict", body: HIDDEN_VERDICT_NOTICE, createdAt: 20, source: "agent:dev" },
    ]);
    expect(redactOperatorCard(createCard())).not.toHaveProperty("rounds");
  });

  it("names a node ticket's draft PR once published and keeps it through a rework round", () => {
    const pullRequestUrl = "https://github.com/acme/app/pull/96";
    const nodeCard = (
      status: WorkboardCard["status"],
      worktree: Partial<NonNullable<Extract<NodeTarget, { kind: "node-claude" }>["worktree"]>>,
    ): WorkboardCard => ({
      ...createCard({
        automation: {
          target: {
            kind: "node-claude",
            nodeId: "node",
            repoPath: "/repo",
            worktreesRoot: "/wt",
            hostRepoPath: "/host",
            worktree: {
              path: "/wt/wb-card-1",
              branch: "factory/card-1",
              baseCommit: "a".repeat(40),
              ...worktree,
            },
          },
        },
      }),
      status,
    });
    const imported = { phase: "imported", headCommit: "b".repeat(40), importedAt: 10 } as const;

    expect(redactOperatorCard(nodeCard("review", { handoff: imported }))).not.toHaveProperty(
      "pullRequestUrl",
    );
    expect(
      redactOperatorCard(
        nodeCard("done", {
          handoff: { ...imported, phase: "published", publishedAt: 20, pullRequestUrl },
        }),
      ).pullRequestUrl,
    ).toBe(pullRequestUrl);
    expect(
      redactOperatorCard(
        nodeCard("running", {
          rework: { round: 1, pullRequestUrl, acceptedAt: 20, outsideCommits: 0 },
        }),
      ).pullRequestUrl,
    ).toBe(pullRequestUrl);
  });

  it("shows the real verdict once the round is decided, and leaves a verdict from before the import", () => {
    const reviewCard = (status: WorkboardCard["status"], events?: WorkboardCard["events"]) => ({
      ...createCard({
        automation: {
          target: {
            kind: "node-claude" as const,
            nodeId: "node",
            repoPath: "/repo",
            worktreesRoot: "/wt",
            hostRepoPath: "/host",
            worktree: {
              path: "/wt/wb-card-1",
              branch: "factory/card-1",
              baseCommit: "a".repeat(40),
              handoff: {
                phase: "imported" as const,
                headCommit: "b".repeat(40),
                importedAt: 10,
              },
            },
          },
        },
        comments: [
          { id: "old", body: "Verdict: rework", createdAt: 5, source: "agent:dev" as const },
          { id: "new", body: "Verdict: accept", createdAt: 20, source: "agent:dev" as const },
        ],
      }),
      status,
      ...(events ? { events } : {}),
    });
    const bodies = (card: WorkboardCard) =>
      redactOperatorCard(card).metadata?.comments?.map((entry) => entry.body);

    expect(bodies(reviewCard("review"))).toEqual(["Verdict: rework", HIDDEN_VERDICT_NOTICE]);
    expect(bodies(reviewCard("done"))).toEqual(["Verdict: rework", "Verdict: accept"]);
    expect(
      bodies(reviewCard("blocked", [{ id: "e", kind: "moved", at: 30, toStatus: "done" }])),
    ).toEqual(["Verdict: rework", "Verdict: accept"]);
  });
});
