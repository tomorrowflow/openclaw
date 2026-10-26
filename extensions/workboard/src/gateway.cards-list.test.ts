import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import { HIDDEN_VERDICT_NOTICE } from "./card-redaction.js";
import { registerWorkboardGatewayMethods } from "./gateway.js";
import { startNodeCard } from "./node-ticket.test-support.js";
import { workboardSqliteBackendEntrypoint } from "./sqlite-backend-entrypoint.test-support.js";
import { WorkboardStore } from "./store.js";
import { createWorkboardSqliteStores } from "./test/database-config.js";
import {
  createWorkboardSqliteTestHarness,
  createWorkboardSqliteTestStore,
} from "./test/sqlite-store.js";

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

describe("workboard card list revisions", () => {
  it("keeps session-filtered payloads and revision receipts separate from full card lists", async () => {
    const { store } = createWorkboardSqliteTestHarness();
    const first = await store.create({ title: "First session", sessionKey: "session-one" });
    const second = await store.create({ title: "Second session", sessionKey: "session-two" });
    const listCards = captureCardsList(store);
    const sessionsBefore = store.sessionsRevision;
    const filtered = (await listCards({ sessionKey: "session-one" })).mock.calls[0]?.[1];
    expect(filtered.cards.map((card: { id: string }) => card.id)).toEqual([first.id]);
    expect(filtered.revision.sessionKey).toBe("session-one");
    expect(store.sessionsRevision).toEqual(sessionsBefore);
    const repeated = (
      await listCards({ sessionKey: "session-one", sinceRevision: filtered.revision })
    ).mock.calls[0]?.[1];
    expect(repeated).toEqual({ unchanged: true, revision: filtered.revision });
    expect(
      (
        await listCards({ sessionKey: "session-two", sinceRevision: filtered.revision })
      ).mock.calls[0]?.[1].cards.map((card: { id: string }) => card.id),
    ).toEqual([second.id]);
    expect(
      (await listCards({ sinceRevision: filtered.revision })).mock.calls[0]?.[1].cards,
    ).toHaveLength(2);
    expect((await listCards({ sessionKey: " " })).mock.calls[0]?.[0]).toBe(false);
  });

  it("refreshes retained lists and session revisions after sibling worker commits", async () => {
    const { store: reader, dbPath } = createWorkboardSqliteTestHarness();
    const stores = createWorkboardSqliteStores({
      dbPath,
      workerModuleUrl: resolveRuntimeWorkerUrl(workboardSqliteBackendEntrypoint),
    });
    const writer = new WorkboardStore(stores.cards, stores);
    try {
      const before = await reader.listCards(undefined);
      expect(before.cards).toEqual([]);
      const card = await writer.create({ title: "Created by sibling" });
      const created = await reader.listCards(undefined);
      expect(created.cards).toEqual([expect.objectContaining({ id: card.id })]);
      expect(created.revision.revision).toBeGreaterThan(before.revision.revision);
      expect(await reader.listCards(undefined)).toBe(created);

      const sessionsBefore = reader.sessionsRevision;
      await writer.upsertBoard({ id: "sessions", kind: "sessions", name: "Sibling board" });
      expect(reader.sessionsRevision.revision).toBeGreaterThan(sessionsBefore.revision);
      expect((await reader.listCards(undefined)).boards).toContainEqual(
        expect.objectContaining({ id: "sessions", name: "Sibling board" }),
      );

      await writer.update(card.id, { title: "Updated by sibling" });
      expect((await reader.listCards(undefined)).cards[0]?.title).toBe("Updated by sibling");
      await writer.delete(card.id);
      expect((await reader.listCards(undefined)).cards).toEqual([]);
    } finally {
      await writer.close();
    }
  });

  it("shares one card payload per revision and publishes one invalidation per mutation", async () => {
    const { store, stores } = createWorkboardSqliteTestHarness();
    const card = await store.create({ title: "Before", boardId: "ops" });
    await store.claim(card.id, { ownerId: "worker", token: "test-claim-token" });
    const reads = vi.spyOn(stores.cards, "entries");
    const changes = vi.fn();
    store.subscribeChanges(changes);
    const listCards = captureCardsList(store);
    const list = async (boardId?: string) => {
      const respond = await listCards({ boardId });
      expect(respond.mock.calls[0]?.[0]).toBe(true);
      return respond.mock.calls[0]?.[1];
    };
    const [first, second] = await Promise.all([list("ops"), list(" OPS ")]);
    expect(second).toBe(first);
    expect(await list("ops")).toBe(first);
    expect(reads).toHaveBeenCalledOnce();
    expect(first.cards[0].metadata.claim.token).toBe("[redacted]");
    expect((await store.get(card.id))?.metadata?.claim?.token).toBe("test-claim-token");
    expect((await list("default")).cards).toEqual([]);
    expect((await list()).cards).toEqual(first.cards);

    store.announceChangeEpoch();
    const announcement = changes.mock.calls[0]?.[0];
    expect(announcement).toMatchObject({
      epoch: first.revision.epoch,
      cardsRevision: first.revision.revision,
    });
    expect(await list("ops")).toBe(first);
    const unchanged = await listCards({ boardId: "ops", sinceRevision: first.revision });
    expect(unchanged.mock.calls[0]?.[1]).toEqual({ unchanged: true, revision: first.revision });
    const otherScope = await listCards({ sinceRevision: first.revision });
    expect(otherScope.mock.calls[0]?.[1].cards).toEqual(first.cards);
    changes.mockClear();

    await store.update(card.id, { title: "After" });
    expect(changes).toHaveBeenCalledOnce();
    const next = await list("ops");
    expect(next).not.toBe(first);
    expect(next.revision.revision).toBeGreaterThan(first.revision.revision);
    const changed = await listCards({ boardId: "ops", sinceRevision: first.revision });
    expect(changed.mock.calls[0]?.[1]).toBe(next);
    const previousEpoch = await listCards({
      boardId: "ops",
      sinceRevision: { ...next.revision, epoch: "retired" },
    });
    expect(previousEpoch.mock.calls[0]?.[1]).toBe(next);
    expect(next.cards[0].title).toBe("After");
    expect(first.cards[0].title).toBe("Before");
    expect(await list("ops")).toBe(next);

    await store.upsertBoard({ id: "empty", name: "Empty board" });
    const withBoard = await list("ops");
    expect(withBoard.boards).toContainEqual(expect.objectContaining({ id: "empty" }));
    expect(withBoard).not.toBe(next);

    expect(changes).toHaveBeenCalledTimes(2);
  });

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

  it("serves the overview from the cached operator card read in the requested board scope", async () => {
    const { store, stores } = createWorkboardSqliteTestHarness();
    const blocked = await store.create({ title: "Flaky deploy", boardId: "ops" });
    await store.move(blocked.id, "blocked", 1);
    const running = await store.create({ title: "Other board" });
    await store.claim(running.id, { ownerId: "worker", token: "test-claim-token" });
    const listCards = captureCardsList(store);
    const overview = captureMethod(store, "workboard.overview");
    expect((await listCards({ boardId: "ops" })).mock.calls[0]?.[0]).toBe(true);
    const reads = vi.spyOn(stores.cards, "entries");

    const respond = await overview({ boardId: "ops" });

    expect(respond.mock.calls[0]?.[0]).toBe(true);
    expect(respond.mock.calls[0]?.[1]).toMatchObject({
      boardId: "ops",
      needsYou: [{ cardId: blocked.id, title: "Flaky deploy", reason: "blocked" }],
      inFlight: [],
      open: { blocked: 1 },
    });
    expect(reads).not.toHaveBeenCalled();
    expect((await overview({})).mock.calls[0]?.[1].inFlight).toEqual([
      expect.objectContaining({
        cardId: running.id,
        stage: expect.objectContaining({ kind: "running" }),
      }),
    ]);
    expect((await overview({ boardId: "not a board" })).mock.calls[0]?.[0]).toBe(false);
  });

  it("retires cached cards when a worker write commits but its reply rejects", async () => {
    const { store, stores } = createWorkboardSqliteTestHarness();
    const card = await store.create({ title: "Before" });
    const listCards = captureCardsList(store);
    const before = await listCards({});
    expect(before.mock.calls[0]?.[1].cards[0].title).toBe("Before");
    const register = stores.cards.registerIfUpdatedAt.bind(stores.cards);
    vi.spyOn(stores.cards, "registerIfUpdatedAt").mockImplementationOnce(async (...args) => {
      await register(...args);
      throw new Error("committed reply lost");
    });

    await expect(store.update(card.id, { title: "Committed" })).rejects.toThrow(
      "committed reply lost",
    );

    const after = await listCards({});
    expect(after.mock.calls[0]?.[1].cards[0].title).toBe("Committed");
    expect(after.mock.calls[0]?.[1].revision.revision).toBeGreaterThan(
      before.mock.calls[0]?.[1].revision.revision,
    );
  });

  it("returns uncached reads while a writer receipt is unsettled", async () => {
    let unsettled = false;
    const { store } = createWorkboardSqliteTestHarness({
      createStores: (dbPath) => {
        const stores = createWorkboardSqliteStores({
          dbPath,
          workerModuleUrl: resolveRuntimeWorkerUrl(workboardSqliteBackendEntrypoint),
        });
        return {
          ...stores,
          readWriteToken: () => (unsettled ? undefined : stores.readWriteToken()),
        };
      },
    });
    const card = await store.create({ title: "Visible during settlement" });
    const cached = await store.listCards(undefined);
    unsettled = true;
    const first = await store.listCards(undefined);
    const second = await store.listCards(undefined);
    expect(first.cards).toEqual([expect.objectContaining({ id: card.id })]);
    expect(second.cards).toEqual(first.cards);
    expect(first).not.toBe(cached);
    expect(second).not.toBe(first);
    unsettled = false;
    const settled = await store.listCards(undefined);
    expect(settled.revision.revision).toBeGreaterThan(second.revision.revision);
    expect(await store.listCards(undefined)).toBe(settled);
  });

  it("retries failed card snapshots and refuses cached reads after store close", async () => {
    const { store, stores } = createWorkboardSqliteTestHarness();
    const listCards = captureCardsList(store);
    vi.spyOn(stores.cards, "entries").mockRejectedValueOnce(new Error("read failed"));
    const failed = await listCards({});
    expect(failed.mock.calls[0]?.[0]).toBe(false);
    const recovered = await listCards({});
    expect(recovered.mock.calls[0]?.[0]).toBe(true);
    await store.close();
    const closed = await listCards({});
    expect(closed.mock.calls[0]?.[0]).toBe(false);
    expect(closed.mock.calls[0]?.[2].message).toContain("closed");
  });
});
