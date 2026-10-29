import type { WorkboardCard, WorkboardNodeVerification } from "@openclaw/workboard-contract";
import { describe, expect, it } from "vitest";
import {
  HIDDEN_VERDICT_NOTICE,
  HIDDEN_VERIFICATION_NOTICE,
  redactCard,
  redactOperatorCard,
} from "./card-redaction.js";

type NodeTarget = NonNullable<
  NonNullable<NonNullable<WorkboardCard["metadata"]>["automation"]>["target"]
>;

const DONE_VERIFICATION = {
  phase: "done" as const,
  round: 0,
  headCommit: "b".repeat(40),
  startedAt: 11,
  endedAt: 12,
  sessionKey: "agent:verifier:verify-card-1-r0-v0",
  model: "openai/gpt-6-sol",
  verdict: "pass" as const,
  summary: "xcodebuild test passed",
  findings: [],
};

/** A node ticket in review on its imported round, with a finished verification. */
function visualCard(
  extra: Partial<Extract<WorkboardNodeVerification, { phase: "done" }>>,
  options: { rung?: "b"; status?: WorkboardCard["status"] } = {},
): WorkboardCard {
  return {
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
            verification: { ...DONE_VERIFICATION, ...extra },
            ...(options.rung ? { rung: options.rung } : {}),
          },
        },
      },
    }),
    status: options.status ?? "review",
  };
}

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

describe("redactCard", () => {
  it("preserves card identity when there is no claim", () => {
    const card = createCard({ archivedAt: 1 });

    expect(redactCard(card)).toBe(card);
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

    const redacted = redactCard(card);

    expect(redacted).not.toBe(card);
    expect(redacted.labels).toBe(card.labels);
    expect(redacted.metadata).not.toBe(card.metadata);
    expect(redacted.metadata?.claim).not.toBe(card.metadata?.claim);
    expect(redacted.metadata?.claim?.token).toBe("[redacted]");
    expect(card.metadata?.claim?.token).toBe("secret-token");
  });

  it("leaves the verifier's visual read out until the operator records a visual check", () => {
    const visual = {
      verdict: "problem" as const,
      screenshots: [{ path: "dark.png", shows: "label unreadable", verdict: "problem" as const }],
    };
    const checked = (visualCheck?: { verdict: "looks_right"; at: number }) =>
      visualCard({ visual, ...(visualCheck ? { visualCheck } : {}) });
    const verificationOf = (card: WorkboardCard) =>
      redactCard(card).metadata?.automation?.target?.worktree?.verification;

    const unchecked = checked();
    expect(verificationOf(unchecked)).toEqual({ ...DONE_VERIFICATION });
    expect(unchecked.metadata?.automation?.target?.worktree?.verification).toHaveProperty("visual");
    const check = { verdict: "looks_right" as const, at: 30 };
    expect(verificationOf(checked(check))).toEqual({
      ...DONE_VERIFICATION,
      visual,
      visualCheck: check,
    });
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
        review: {
          findings: 2,
          fixed: 1,
          items: [
            { path: "parser.py", line: 4, rule: "Name the why", body: "Bare except", fixed: false },
            { path: "parser.py", line: 9, body: "Unused import", fixed: true },
          ],
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
    const pullRequest = (card: WorkboardCard) => {
      const { pullRequestUrl: url, publishedRound } = redactOperatorCard(card);
      return { url, publishedRound };
    };
    expect(
      pullRequest(
        nodeCard("done", {
          handoff: { ...imported, phase: "published", publishedAt: 20, pullRequestUrl },
        }),
      ),
    ).toEqual({ url: pullRequestUrl, publishedRound: 0 });
    // A running rework round builds on the round before it, which is on the PR branch.
    expect(
      pullRequest(
        nodeCard("running", {
          rework: { round: 1, pullRequestUrl, acceptedAt: 20, outsideCommits: 0 },
        }),
      ),
    ).toEqual({ url: pullRequestUrl, publishedRound: 0 });
    // The old PR was closed, so the rework round's publish opened a new one.
    const reopenedUrl = "https://github.com/acme/app/pull/97";
    expect(
      pullRequest(
        nodeCard("done", {
          handoff: {
            ...imported,
            phase: "published",
            publishedAt: 30,
            pullRequestUrl: reopenedUrl,
          },
          rework: { round: 1, pullRequestUrl, acceptedAt: 20, outsideCommits: 0 },
        }),
      ),
    ).toEqual({ url: reopenedUrl, publishedRound: 1 });
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

  it("hides a rung a round's finished verification until the operator decides, shows a rung b one", () => {
    const done = {
      phase: "done" as const,
      round: 0,
      headCommit: "b".repeat(40),
      startedAt: 11,
      endedAt: 12,
      sessionKey: "agent:verifier:verify-card-1-r0",
      model: "openai/gpt-6-sol",
      verdict: "fail" as const,
      summary: "pytest fails on empty input",
      findings: [{ path: "parser.py", line: 4, body: "returns None" }],
    };
    const running = {
      phase: "running" as const,
      round: 0,
      headCommit: "b".repeat(40),
      startedAt: 11,
      sessionKey: "agent:verifier:verify-card-1-r0",
      path: "/wt/verify-card-1-r0",
    };
    const verifiedCard = (
      verification: typeof done | typeof running | undefined,
      options: { rung?: "b"; status?: WorkboardCard["status"] } = {},
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
              handoff: { phase: "imported", headCommit: "b".repeat(40), importedAt: 10 },
              ...(verification ? { verification } : {}),
              ...(options.rung ? { rung: options.rung } : {}),
            },
          },
        },
        comments: [
          {
            id: "v",
            body: "**Verification:** fail (openai/gpt-6-sol)\n\npytest fails on empty input",
            createdAt: 12,
            source: "agent:verifier",
          },
          {
            id: "n",
            body: "Verification: I will run it tonight.",
            createdAt: 13,
            source: "operator",
          },
        ],
      }),
      status: options.status ?? "review",
    });
    const view = (card: WorkboardCard) => {
      const redacted = redactOperatorCard(card);
      return {
        bodies: redacted.metadata?.comments?.map((entry) => entry.body),
        verification: redacted.metadata?.automation?.target?.worktree?.verification,
      };
    };

    expect(view(verifiedCard(done))).toEqual({
      bodies: [HIDDEN_VERIFICATION_NOTICE, "Verification: I will run it tonight."],
      verification: undefined,
    });
    // A re-run keeps the previous run's comment hidden; its running record holds a slot and stays.
    expect(view(verifiedCard(running))).toEqual({
      bodies: [HIDDEN_VERIFICATION_NOTICE, "Verification: I will run it tonight."],
      verification: running,
    });
    // The operator's re-run drops the record; the comment of the hidden result stays hidden.
    expect(view(verifiedCard(undefined))).toEqual({
      bodies: [HIDDEN_VERIFICATION_NOTICE, "Verification: I will run it tonight."],
      verification: undefined,
    });
    expect(view(verifiedCard(done, { rung: "b" })).verification).toEqual(done);
    expect(view(verifiedCard(undefined, { rung: "b" })).bodies?.[0]).toContain(
      "**Verification:** fail",
    );
    expect(view(verifiedCard(done, { status: "done" })).verification).toEqual(done);
    expect(view(verifiedCard(done, { status: "done" })).bodies?.[0]).toContain(
      "**Verification:** fail",
    );
    expect(view(verifiedCard({ ...done, round: 1 })).verification).toEqual({ ...done, round: 1 });
    // Nobody decides a probe's round, so its verification shows at rung a too.
    const round = verifiedCard(done);
    const probe = { of: "source", arm: "base", createdAt: 1 };
    expect(
      view({
        ...round,
        metadata: { ...round.metadata, automation: { ...round.metadata?.automation, probe } },
      }).verification,
    ).toEqual(done);
  });

  it("derives the visual check at every rung and shows the visual read only once checked", () => {
    const visual = { verdict: "looks_right" as const, screenshots: [] };
    const check = { verdict: "problem" as const, note: "Record button grey in dark mode", at: 30 };
    const view = (card: WorkboardCard) => {
      const redacted = redactOperatorCard(card);
      return {
        visualCheck: redacted.visualCheck,
        verification: redacted.metadata?.automation?.target?.worktree?.verification,
      };
    };

    // Rung a, undecided: the record stays hidden, the operator's check field does not.
    expect(view(visualCard({ visual }))).toEqual({
      visualCheck: { round: 0 },
      verification: undefined,
    });
    expect(view(visualCard({ visual, visualCheck: check }))).toEqual({
      visualCheck: { round: 0, check },
      verification: undefined,
    });
    // Rung b shows the record, still without the unchecked read.
    expect(view(visualCard({ visual }, { rung: "b" }))).toEqual({
      visualCheck: { round: 0 },
      verification: DONE_VERIFICATION,
    });
    expect(view(visualCard({ visual, visualCheck: check }, { rung: "b" }))).toEqual({
      visualCheck: { round: 0, check },
      verification: { ...DONE_VERIFICATION, visual, visualCheck: check },
    });
    // Deciding the round does not reveal a read the operator never checked.
    expect(view(visualCard({ visual }, { status: "done" })).verification).toEqual(
      DONE_VERIFICATION,
    );
    // A stale record, of another round, has no visual check to record.
    expect(view(visualCard({ round: 1, visual })).visualCheck).toBeUndefined();
    expect(redactOperatorCard(createCard())).not.toHaveProperty("visualCheck");
  });
});
