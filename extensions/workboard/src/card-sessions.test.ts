import type {
  WorkboardCard,
  WorkboardNodeVerification,
  WorkboardNodeWorktree,
  WorkboardRunAttempt,
} from "@openclaw/workboard-contract";
import { describe, expect, it } from "vitest";
import { redactOperatorCard } from "./card-redaction.js";

const IMPLEMENTER = "agent:dev:subagent:workboard-default-card-1";
const VERIFIER_R0 = "agent:verifier:verify-card-1-r0-v0";
const VERIFIER_R1 = "agent:verifier:verify-card-1-r1-v0";
const CROSS_R1 = "agent:cross:verify-card-1-r1-v0";
const VERDICT_R0 = "agent:dev:review-r0";
const VERDICT_R1 = "agent:dev:review-r1";
const GRILL = "agent:dev:grill-card-1-1";

function attempt(
  id: string,
  startedAt: number,
  status: WorkboardRunAttempt["status"],
): WorkboardRunAttempt {
  return { id, status, startedAt, sessionKey: IMPLEMENTER };
}

function verification(
  round: number,
  sessionKey: string,
  phase: "running" | "done" = "done",
): WorkboardNodeVerification {
  const base = { round, headCommit: "c".repeat(40), startedAt: 120, sessionKey };
  return phase === "running"
    ? { ...base, phase, path: "/wt/verify" }
    : { ...base, phase, endedAt: 130, verdict: "pass", summary: "ok", findings: [] };
}

/**
 * A node ticket whose first round was published at 100 and whose rework round
 * 1 was imported at 110 and waits in review.
 */
function reworkedCard(
  worktree: Partial<WorkboardNodeWorktree> = {},
  card: Partial<WorkboardCard> = {},
): WorkboardCard {
  return {
    id: "card-1",
    title: "Parse empty input",
    status: "review",
    priority: "normal",
    labels: [],
    position: 1,
    createdAt: 1,
    updatedAt: 1,
    sessionKey: IMPLEMENTER,
    ...card,
    metadata: {
      attempts: [attempt("a1", 10, "succeeded"), attempt("a2", 105, "succeeded")],
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
            rework: {
              round: 1,
              pullRequestUrl: "https://github.com/acme/app/pull/7",
              acceptedAt: 100,
              outsideCommits: 0,
            },
            reviews: [
              {
                round: 0,
                verdict: "accept",
                importedAt: 50,
                publishedAt: 100,
                verdictSessionKey: VERDICT_R0,
                verification: { verdict: "pass", sessionKey: VERIFIER_R0 },
              },
            ],
            handoff: {
              phase: "imported",
              headCommit: "c".repeat(40),
              importedAt: 110,
              verdictSessionKey: VERDICT_R1,
            },
            verification: verification(1, VERIFIER_R1),
            ...worktree,
          },
        },
      },
    },
  };
}

const sessionsOf = (card: WorkboardCard) => redactOperatorCard(card).sessions;

describe("workboardCardSessions", () => {
  it("lists each round's sessions and keeps the undecided round's reviewers blind", () => {
    const card = reworkedCard();

    expect(sessionsOf(card)).toEqual([
      { role: "implementer", round: 0, state: "finished", sessionKey: IMPLEMENTER },
      { role: "verifier", round: 0, state: "finished", sessionKey: VERIFIER_R0 },
      { role: "verdict", round: 0, state: "finished", sessionKey: VERDICT_R0 },
      { role: "implementer", round: 1, state: "finished", sessionKey: IMPLEMENTER },
      { role: "verifier", round: 1, state: "finished", blind: true },
      { role: "verdict", round: 1, state: "finished", blind: true },
    ]);
    const json = JSON.stringify(redactOperatorCard(card));
    for (const hidden of [VERIFIER_R1, VERDICT_R1]) {
      expect(json).not.toContain(hidden);
    }
    // A decided round's sessions stay listed.
    expect(json).toContain(VERIFIER_R0);
    expect(json).toContain(VERDICT_R0);
  });

  it("lists a rung c round's reviewers blind although its verification is visible", () => {
    const card = reworkedCard({ rung: "c", crossVerification: verification(1, CROSS_R1) });

    const sessions = sessionsOf(card) ?? [];
    expect(sessions.filter((entry) => entry.round === 1 && entry.role !== "implementer")).toEqual([
      { role: "verifier", round: 1, state: "finished", blind: true },
      { role: "cross_verifier", round: 1, state: "finished", blind: true },
      { role: "verdict", round: 1, state: "finished", blind: true },
    ]);
    expect(JSON.stringify(redactOperatorCard(card))).not.toContain(VERDICT_R1);
  });

  it("opens the round's reviewers once the operator decides it", () => {
    const decided = reworkedCard(
      { rung: "c", crossVerification: verification(1, CROSS_R1) },
      { status: "done" },
    );

    expect(sessionsOf(decided)?.filter((entry) => entry.round === 1)).toEqual([
      { role: "implementer", round: 1, state: "finished", sessionKey: IMPLEMENTER },
      { role: "verifier", round: 1, state: "finished", sessionKey: VERIFIER_R1 },
      { role: "cross_verifier", round: 1, state: "finished", sessionKey: CROSS_R1 },
      { role: "verdict", round: 1, state: "finished", sessionKey: VERDICT_R1 },
    ]);
  });

  it("keeps a running verifier blind and shows a running implementer and an open grill", () => {
    const card = reworkedCard({
      handoff: { phase: "imported", headCommit: "c".repeat(40), importedAt: 110 },
      verification: verification(1, VERIFIER_R1, "running"),
      crossVerification: undefined,
      grill: { status: "open", rounds: 1, attachmentId: "grilling", sessionKey: GRILL },
    });
    card.metadata!.attempts!.push(attempt("a3", 140, "running"));

    expect(sessionsOf(card)?.filter((entry) => entry.round === 1)).toEqual([
      { role: "implementer", round: 1, state: "running", sessionKey: IMPLEMENTER },
      { role: "grill", round: 1, state: "running", sessionKey: GRILL },
      { role: "verifier", round: 1, state: "running", blind: true },
    ]);
    expect(JSON.stringify(redactOperatorCard(card))).not.toContain(VERIFIER_R1);
  });

  it("lists a plain card's linked session as its implementer", () => {
    const card: WorkboardCard = {
      id: "card-2",
      title: "Write notes",
      status: "running",
      priority: "normal",
      labels: [],
      position: 1,
      createdAt: 1,
      updatedAt: 1,
      sessionKey: "agent:main:dashboard:1",
      execution: {
        id: "exec-1",
        kind: "agent-session",
        mode: "autonomous",
        status: "running",
        startedAt: 1,
        updatedAt: 1,
      },
    };

    expect(sessionsOf(card)).toEqual([
      { role: "implementer", round: 0, state: "running", sessionKey: "agent:main:dashboard:1" },
    ]);
  });
});
