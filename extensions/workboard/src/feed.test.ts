import type { WorkboardCard } from "@openclaw/workboard-contract";
import { describe, expect, it } from "vitest";
import {
  collectFeedFacts,
  diffFeedFacts,
  feedCommentEvents,
  feedCardRef,
  feedThreadName,
  HELD_MERGE_NAMESPACE,
  parseHeldMergePayload,
  renderFeedEvent,
  type FeedEvent,
  type WorkboardFeedFacts,
} from "./feed.js";

const base: WorkboardFeedFacts = { status: "todo", commentsThrough: 0 };
const verdict = (endedAt: number, v: "pass" | "fail", summary = "proof re-ran") => ({
  endedAt,
  verdict: v,
  summary,
});

describe("diffFeedFacts", () => {
  it.each<[string, Partial<WorkboardFeedFacts>, Partial<WorkboardFeedFacts>, FeedEvent[]]>([
    ["nothing changed", {}, {}, []],
    [
      "start on a node",
      {},
      { status: "running", nodeId: "mac" },
      [{ kind: "started", nodeId: "mac" }],
    ],
    ["round imported", { handoff: "pending" }, { handoff: "imported" }, [{ kind: "handoff" }]],
    [
      "new verification",
      { verification: verdict(1, "pass") },
      { verification: verdict(2, "fail", "test broke") },
      [{ kind: "verdict", check: "verification", verdict: "fail", summary: "test broke" }],
    ],
    [
      "same verification",
      { verification: verdict(1, "pass") },
      { verification: verdict(1, "pass") },
      [],
    ],
    [
      "new review entry",
      { review: { count: 1, round: 1, verdict: "rework" } },
      { review: { count: 2, round: 2, verdict: "accept" } },
      [{ kind: "review", round: 2, verdict: "accept" }],
    ],
    [
      "PR published, held, and merged in one pass",
      {},
      {
        pullRequest: {
          url: "u",
          state: "merged",
          autoMerged: true,
          heldPaths: ["infra/"],
          heldAt: "h1",
        },
      },
      [
        { kind: "pr_opened", url: "u" },
        { kind: "pr_held", paths: ["infra/"], headCommit: "h1" },
        { kind: "pr_merged", url: "u", auto: true },
      ],
    ],
    [
      "held again at a new head",
      { pullRequest: { url: "u", heldPaths: ["infra/"], heldAt: "h1" } },
      { pullRequest: { url: "u", heldPaths: ["infra/"], heldAt: "h2" } },
      [{ kind: "pr_held", paths: ["infra/"], headCommit: "h2" }],
    ],
    [
      "still held at the same head",
      { pullRequest: { url: "u", heldPaths: ["infra/"], heldAt: "h1" } },
      { pullRequest: { url: "u", heldPaths: ["infra/"], heldAt: "h1" } },
      [],
    ],
    ["rework round", { reworkRound: 1 }, { reworkRound: 2 }, [{ kind: "rework", round: 2 }]],
    ["needs:user added", {}, { needsUser: true }, [{ kind: "needs_user" }]],
    ["needs:user removed", { needsUser: true }, {}, []],
    ["blocked", { status: "running" }, { status: "blocked" }, [{ kind: "blocked" }]],
    [
      "done then archived",
      { status: "review" },
      { status: "done", archived: true },
      [{ kind: "done" }, { kind: "archived" }],
    ],
  ])("%s", (_name, prev, next, expected) => {
    expect(diffFeedFacts({ ...base, ...prev }, { ...base, ...next })).toEqual(expected);
  });
});

describe("collectFeedFacts and feedCommentEvents", () => {
  const card: WorkboardCard = {
    id: "0123456789abcdef",
    title: "Feed card",
    status: "review",
    priority: "normal",
    labels: ["needs:user"],
    position: 0,
    createdAt: 1,
    updatedAt: 1,
    metadata: {
      comments: [
        { id: "c1", body: "old", createdAt: 10, source: "agent:dev" },
        { id: "c2", body: "claimed reply", createdAt: 20, source: "operator" },
        { id: "c3", body: "  Verdict:\n accept  ", createdAt: 30, source: "agent:verifier" },
      ],
      automation: {
        target: {
          kind: "node-claude",
          nodeId: "mac",
          repoPath: "/r",
          worktreesRoot: "/w",
          hostRepoPath: "/h",
          worktree: {
            path: "/w/1",
            branch: "b",
            baseCommit: "c",
            handoff: { phase: "imported", headCommit: "h", importedAt: 5 },
          },
        },
      },
    },
  };

  it("reads the card's feed facts", () => {
    expect(collectFeedFacts(card)).toEqual({
      status: "review",
      needsUser: true,
      nodeId: "mac",
      handoff: "imported",
      commentsThrough: 30,
    });
  });

  it("posts comments after the watermark except the claimed ones, as one line", () => {
    const events = feedCommentEvents(card, {
      seen: { ...base, commentsThrough: 10 },
      claimedCommentIds: ["c2"],
    });
    expect(events).toEqual([
      { kind: "comment", commentId: "c3", source: "agent:verifier", body: "Verdict: accept" },
    ]);
  });

  it("caps thread names at 100 characters", () => {
    expect(feedThreadName({ ...card, title: "x".repeat(200) })).toHaveLength(100);
  });

  it.each([
    ["[IOS-A90] Fix excerpt", "IOS-A90", "[IOS-A90] Fix excerpt"],
    ["Fix login", card.id.slice(0, 8), `[${card.id.slice(0, 8)}] Fix login`],
    ["[@everyone] x", "@\u200beveryone", "[@everyone] x"],
  ])("keys %j", (title, ref, name) => {
    expect(feedCardRef({ ...card, title })).toBe(ref);
    expect(feedThreadName({ ...card, title })).toBe(name);
  });
});

describe("renderFeedEvent", () => {
  const ctx = {
    cardId: "card-1",
    ref: "abc12345",
    agentId: "dev",
    orchestration: {
      verifier: { agentId: "verifier", model: "m" },
      crossVerifier: { agentId: "cross", model: "m" },
    },
  };

  it.each<[FeedEvent, string, string, boolean]>([
    [
      { kind: "handoff" },
      "agent:dev",
      "@verifier abc12345 is yours: the round is ready to verify.",
      false,
    ],
    [
      { kind: "verdict", check: "verification", verdict: "fail", summary: "test broke" },
      "agent:verifier",
      "fail: test broke -> back to @dev",
      false,
    ],
    [
      { kind: "verdict", check: "verification", verdict: "pass", summary: "ok" },
      "agent:verifier",
      "pass: ok -> @cross",
      false,
    ],
    [
      { kind: "verdict", check: "crossVerification", verdict: "pass", summary: "ok" },
      "agent:cross",
      "pass: ok -> review",
      false,
    ],
    [{ kind: "needs_user" }, "workboard", "abc12345 needs you.", true],
    [{ kind: "blocked" }, "workboard", "abc12345 is blocked.", true],
    [
      { kind: "comment", commentId: "c", source: "operator", body: "ping @everyone <@123>" },
      "operator",
      "ping @​everyone <​@123>",
      false,
    ],
    [{ kind: "comment", commentId: "c", body: "notice" }, "workboard", "notice", false],
  ])("renders %j", (event, persona, text, mentionOperator) => {
    const post = renderFeedEvent(event, ctx);
    const who = post.persona.kind === "agent" ? `agent:${post.persona.agentId}` : post.persona.kind;
    expect({ who, text: post.text, mentionOperator: post.mentionOperator }).toEqual({
      who: persona,
      text,
      mentionOperator,
    });
    expect(post.buttons).toBeUndefined();
  });

  it("puts the operator's two choices under a hold, naming the card and the held head", () => {
    const post = renderFeedEvent({ kind: "pr_held", paths: ["infra/"], headCommit: "f00d" }, ctx);
    expect(post.text).toBe("The PR waits for the operator's merge: it touches infra/");
    expect(post.buttons?.map((button) => button.label)).toEqual(["Approve merge", "Keep holding"]);
    const pressed = post.buttons?.map((button) => {
      const [namespace, ...payload] = button.value.split(":");
      return [namespace, parseHeldMergePayload(payload.join(":"))];
    });
    expect(pressed).toEqual([
      [HELD_MERGE_NAMESPACE, { action: "approve", cardId: "card-1", headCommit: "f00d" }],
      [HELD_MERGE_NAMESPACE, { action: "hold", cardId: "card-1", headCommit: "f00d" }],
    ]);
    expect(parseHeldMergePayload("merge:card-1:f00d")).toBeUndefined();
  });
});
