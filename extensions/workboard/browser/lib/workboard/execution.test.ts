// @vitest-environment node
import "../../test/host.setup.ts";
import { describe, expect, it } from "vitest";
import { canStartWorkboardCard, startWorkboardCard, stopWorkboardCard } from "./execution.ts";
import { getWorkboardState } from "./runtime.ts";
import { createWorkboardCard, createWorkboardTestClient } from "./test/index-helpers.ts";

describe("Workboard native execution", () => {
  it("starts through the card owner and uses its accepted session", async () => {
    const host = {};
    const card = createWorkboardCard();
    const started = {
      ...card,
      status: "running",
      sessionKey: "agent:main:subagent:worker",
      runId: "run-1",
    };
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [card];
    const client = createWorkboardTestClient({ "workboard.cards.start": { card: started } });
    expect(await startWorkboardCard({ host, client, card })).toBe(started.sessionKey);
    expect(client.request.mock.calls.map(([method]) => method)).toEqual(["workboard.cards.start"]);
    expect(state.cards[0]?.runId).toBe("run-1");
  });

  it("aborts the recorded native session run before updating the card", async () => {
    const host = {};
    const card = createWorkboardCard({
      status: "running",
      sessionKey: "agent:main:dashboard:worker",
      runId: "run-1",
    });
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [card];
    const client = createWorkboardTestClient({
      "chat.abort": { aborted: true },
      "workboard.cards.update": { card: { ...card, status: "blocked" } },
    });
    await stopWorkboardCard({ host, client, card });
    expect(client.request.mock.calls.map(([method]) => method)).toEqual([
      "chat.abort",
      "workboard.cards.update",
    ]);
    expect(client.request.mock.calls[0]?.[1]).toMatchObject({ runId: "run-1" });
    expect(state.cards[0]?.status).toBe("blocked");
  });

  it("does not claim cancellation when the native owner aborted nothing", async () => {
    const host = {};
    const card = createWorkboardCard({
      sessionKey: "agent:main:dashboard:worker",
      runId: "finished-run",
    });
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [card];
    const client = createWorkboardTestClient({ "chat.abort": { aborted: false } });
    await stopWorkboardCard({ host, client, card });
    expect(client.request.mock.calls.map(([method]) => method)).toEqual([
      "chat.abort",
      "chat.abort",
    ]);
    expect(state.cards[0]).toEqual(card);
  });

  const nodeTarget = {
    kind: "node-claude",
    nodeId: "mac-factory",
    repoPath: "/Users/factory/repos/app",
    worktreesRoot: "/Users/factory/worktrees",
    hostRepoPath: "/home/openclaw/repos/app",
  } as const;
  const nodeTicket = (status: "running" | "todo" | "blocked") =>
    createWorkboardCard({
      status,
      sessionKey: "agent:dev:subagent:workboard-default-card-1",
      runId: "run-1",
      metadata: { automation: { target: nodeTarget } },
    });

  it("stops a node ticket through Workboard so the stop is recorded before the abort", async () => {
    const host = {};
    const card = nodeTicket("running");
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [card];
    const client = createWorkboardTestClient({
      "workboard.cards.stop": { card: { ...card, status: "todo" } },
    });
    await stopWorkboardCard({ host, client, card });
    expect(client.request.mock.calls).toEqual([
      ["workboard.cards.stop", { id: card.id, expectedUpdatedAt: card.updatedAt }],
    ]);
    expect(state.cards[0]?.status).toBe("todo");
  });

  it("restarts a stopped node ticket that keeps its session link", async () => {
    const host = {};
    const card = nodeTicket("todo");
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [card];
    const client = createWorkboardTestClient({
      "workboard.cards.start": { card: { ...card, status: "running", runId: "run-2" } },
    });
    expect(canStartWorkboardCard(nodeTicket("blocked"))).toBe(false);
    expect(await startWorkboardCard({ host, client, card })).toBe(card.sessionKey);
    expect(client.request.mock.calls.map(([method]) => method)).toEqual(["workboard.cards.start"]);
    expect(state.cards[0]?.runId).toBe("run-2");
  });
});
