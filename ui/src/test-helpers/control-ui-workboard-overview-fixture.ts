import type { WorkboardOverviewResult } from "@openclaw/workboard-contract";

/** A done node ticket's stage and PR once GitHub reports the PR merged. */
export function workboardMergedPullRequestFixture(baseTime: number) {
  const pullRequestUrl = "https://github.com/acme/app/pull/398";
  return {
    stage: {
      kind: "published",
      since: baseTime - 2 * 60 * 60 * 1000,
      pullRequestUrl,
      reworkRound: 0,
      pullRequestState: "merged",
    },
    pullRequestUrl,
  };
}

/** A Factory overview with every band populated, across the Product Operations board. */
export function buildWorkboardOverviewFixture(
  boardId: string,
  baseTime: number,
): WorkboardOverviewResult {
  const hour = 60 * 60 * 1000;
  const pr = (number: number) => `https://github.com/acme/app/pull/${number}`;
  return {
    boardId: "all",
    generatedAt: baseTime,
    needsYou: [
      {
        cardId: "card-review",
        boardId,
        title: "Fix the parser crash on empty input",
        summary:
          "Empty input crashed the parser and users lost their draft. The branch adds a guard and a regression test.",
        stage: { kind: "awaiting_review", since: baseTime - 5 * hour },
        reason: "decide",
        waitingSince: baseTime - 5 * hour,
      },
      {
        cardId: "card-questions",
        boardId,
        title: "Migrate billing exports to the new schema",
        summary: "The agent needs to know whether **archived invoices** move too.",
        stage: { kind: "questions", since: baseTime - 3 * hour, escalatedAt: baseTime - 2 * hour },
        reason: "questions",
        waitingSince: baseTime - 2 * hour,
      },
      {
        cardId: "card-sampled",
        boardId,
        title: "Document the retry policy",
        stage: {
          kind: "published",
          since: baseTime - hour,
          pullRequestUrl: pr(412),
          reworkRound: 0,
          pullRequestState: "open",
        },
        reason: "sampled",
        waitingSince: baseTime - hour,
      },
    ],
    inFlight: [
      {
        cardId: "card-running",
        boardId,
        title: "Retry failed uploads with backoff",
        summary: "Uploads that fail on a flaky network now retry three times before they surface.",
        stage: {
          kind: "running",
          since: baseTime - 40 * 60 * 1000,
          nodeId: "mac-factory",
          reworkRound: 1,
        },
        nodeId: "mac-factory",
        round: 1,
        contextTokens: 92_000,
      },
      {
        cardId: "card-queued",
        boardId,
        title: "Remove the dead feature flags",
        stage: { kind: "queued", since: baseTime - 20 * 60 * 1000 },
        nodeId: "mac-factory",
        round: 0,
      },
    ],
    shipped: [
      {
        cardId: "card-sampled",
        boardId,
        title: "Document the retry policy",
        stage: {
          kind: "published",
          since: baseTime - hour,
          pullRequestUrl: pr(412),
          reworkRound: 0,
          pullRequestState: "open",
        },
        shippedAt: baseTime - hour,
        pullRequestUrl: pr(412),
        rounds: 1,
        decidedBy: "agent",
        sampled: true,
      },
      {
        cardId: "card-shipped",
        boardId,
        title: "Speed up the settings page",
        summary: "Settings load in one request instead of six.",
        stage: {
          kind: "published",
          since: baseTime - 30 * hour,
          pullRequestUrl: pr(405),
          reworkRound: 1,
          pullRequestState: "merged",
        },
        shippedAt: baseTime - 30 * hour,
        pullRequestUrl: pr(405),
        rounds: 2,
        decidedBy: "operator",
        shadowVerdict: "accept",
      },
    ],
    insights: [
      {
        cardId: "card-insight",
        boardId,
        title: "Split the 1,400-line store module",
        summary: "Three responsibilities share one file; each change touches all of them.",
        label: "architecture",
        createdAt: baseTime - 48 * hour,
      },
    ],
    open: { backlog: 4, todo: 3, running: 1, review: 2 },
    week: { weekStart: baseTime - 72 * hour, accepted: 3, autonomous: 2 },
  };
}
