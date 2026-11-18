import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import { HIDDEN_VERDICT_NOTICE } from "./card-redaction.js";
import { registerWorkboardGatewayMethods } from "./gateway.js";
import { startNodeCard } from "./node-ticket.test-support.js";
import { WorkboardStore } from "./store.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

function captureMethod(store: WorkboardStore, method: string) {
  let handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
  const api = createTestPluginApi({
    registerGatewayMethod: (name, registered) => {
      if (name === method) {
        handler = registered;
      }
    },
  });
  registerWorkboardGatewayMethods({ api, store });
  return async (params: Record<string, unknown>) => {
    const respond = vi.fn();
    await handler({ params, respond } as never);
    return respond;
  };
}

function captureCardsList(store: WorkboardStore) {
  return captureMethod(store, "workboard.cards.list");
}

// Fork-only operator card-list contracts (shadow verdict, stage, overview).
describe("workboard card list operator view", () => {
  it("holds dev's shadow verdict back from the operator until the review is decided", async () => {
    const store = createWorkboardSqliteTestStore();
    const { card } = await startNodeCard(store);
    const worktree = (await store.get(card.id))!.metadata!.automation!.target!.worktree!;
    const importedAt = Date.now();
    await store.setNodeHandoff(card.id, {
      worktreePath: worktree.path,
      handoff: { phase: "imported", headCommit: "b".repeat(40), importedAt },
    });
    await store.update(card.id, { status: "review" });
    await store.addComment(card.id, { body: "Proof looks thin." }, undefined, "operator");
    await store.addComment(
      card.id,
      { body: "**Verdict:** rework: no test" },
      undefined,
      "agent:dev",
    );
    const listCards = captureCardsList(store);
    const listed = async () => (await listCards({})).mock.calls[0]?.[1].cards[0];
    const comments = async () =>
      (await listed()).metadata.comments.map((comment: { body: string }) => comment.body);

    expect(await comments()).toEqual(["Proof looks thin.", HIDDEN_VERDICT_NOTICE]);
    // The wait starts at the hidden verdict's arrival; only its time shows.
    const verdictAt = (await store.get(card.id))?.metadata?.comments?.at(-1)?.createdAt;
    expect((await listed()).stage).toEqual({ kind: "awaiting_review", since: verdictAt });
    expect((await store.get(card.id))?.metadata?.comments).toHaveLength(2);

    await store.update(card.id, { status: "done" });
    expect(await comments()).toEqual(["Proof looks thin.", "**Verdict:** rework: no test"]);
    expect((await listed()).stage).toMatchObject({ kind: "done" });

    // A failed publish blocks the decided card; the verdict stays visible.
    await store.update(card.id, { status: "blocked" });
    expect(await comments()).toEqual(["Proof looks thin.", "**Verdict:** rework: no test"]);
    expect((await listed()).stage).toMatchObject({ kind: "blocked" });
  });

  it("lists a card's summary and derived stage but never stores the stage", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({
      title: "Parser crash",
      summary: "Empty input crashes the parser. Users lose their draft.",
    });
    const listCards = captureCardsList(store);
    const listed = async () => (await listCards({})).mock.calls[0]?.[1].cards[0];

    expect((await listed()).metadata.automation.summary).toBe(
      "Empty input crashes the parser. Users lose their draft.",
    );
    expect((await listed()).stage).toBeUndefined();

    await store.claim(card.id, { ownerId: "worker", token: "test-claim-token" });
    const running = await listed();
    expect(running.stage).toEqual({ kind: "running", since: expect.any(Number) });
    expect(await store.get(card.id)).not.toHaveProperty("stage");
  });

  it("serves the overview from the operator card read in the requested board scope", async () => {
    const store = createWorkboardSqliteTestStore();
    const blocked = await store.create({ title: "Flaky deploy", boardId: "ops" });
    await store.move(blocked.id, "blocked", 1);
    const running = await store.create({ title: "Other board" });
    await store.claim(running.id, { ownerId: "worker", token: "test-claim-token" });
    const overview = captureMethod(store, "workboard.overview");

    const respond = await overview({ boardId: "ops" });

    expect(respond.mock.calls[0]?.[0]).toBe(true);
    expect(respond.mock.calls[0]?.[1]).toMatchObject({
      boardId: "ops",
      needsYou: [{ cardId: blocked.id, title: "Flaky deploy", reason: "blocked" }],
      inFlight: [],
      open: { blocked: 1 },
    });
    expect((await overview({})).mock.calls[0]?.[1].inFlight).toEqual([
      expect.objectContaining({
        cardId: running.id,
        stage: expect.objectContaining({ kind: "running" }),
      }),
    ]);
    expect((await overview({ boardId: "not a board" })).mock.calls[0]?.[0]).toBe(false);
  });
});
