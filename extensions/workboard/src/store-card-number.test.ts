import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { describe, expect, it } from "vitest";
import { NODE_TARGET } from "./node-ticket.test-support.js";
import { workboardSqliteBackendEntrypoint } from "./sqlite-backend-entrypoint.test-support.js";
import { WorkboardStore } from "./store.js";
import { createWorkboardSqliteStores } from "./test/database-config.js";
import { sqliteOnly } from "./test/sqlite-only.js";
import {
  createWorkboardSqliteTestHarness,
  createWorkboardSqliteTestStore,
} from "./test/sqlite-store.js";

async function keyedBoard() {
  const store = createWorkboardSqliteTestStore();
  await store.upsertBoard({ id: "lindra", name: "Lindra", orchestration: { key: "LIN" } });
  const create = (input: Record<string, unknown>) => store.create({ boardId: "lindra", ...input });
  return { store, create };
}

describe("card numbers", () => {
  it("leaves cards on a board without a key unnumbered and refuses a number there", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({ title: "[LFR-21] Plain", kind: "spec" });
    expect(card).toMatchObject({ title: "[LFR-21] Plain", kind: "spec" });
    expect(card.release).toBeUndefined();
    await expect(store.create({ title: "Placed", seq: 4 })).rejects.toThrow("has no key");
  });

  it("opens a release with each spec and numbers the cards after it", async () => {
    const { create } = await keyedBoard();
    const early = await create({ title: "Before any spec" });
    const spec = await create({ title: "[SPEC-2] Arztbrief", kind: "spec" });
    const ticket = await create({ title: "[LFR-21] Case data", status: "todo" });
    const bug = await create({ title: "Upload drops a page", kind: "bug" });
    const next = await create({ title: "Third release", kind: "spec" });
    const after = await create({ title: "Follow-up" });

    expect(early).toMatchObject({ title: "[LIN-1.01] Before any spec", release: 1, seq: 1 });
    expect(spec).toMatchObject({ title: "[LIN-2.00] Arztbrief", kind: "spec", release: 2, seq: 0 });
    expect(ticket).toMatchObject({ title: "[LIN-2.01] Case data", release: 2, seq: 1 });
    expect(ticket.kind).toBeUndefined();
    expect(bug).toMatchObject({ title: "[LIN-2.02] Upload drops a page", kind: "bug" });
    expect(next.title).toBe("[LIN-3.00] Third release");
    expect(after.title).toBe("[LIN-3.01] Follow-up");
  });

  it("places a spec ticket at its file number and never hands a number out twice", async () => {
    const { store, create } = await keyedBoard();
    await create({ title: "Spec", kind: "spec" });
    const placed = await create({ title: "Evaluation", seq: 13 });
    expect(placed.title).toBe("[LIN-1.13] Evaluation");
    await expect(create({ title: "Again", seq: 13 })).rejects.toThrow("1.13 is already taken");
    await store.update(placed.id, { metadata: { archivedAt: Date.now() } });
    expect((await create({ title: "Next" })).title).toBe("[LIN-1.14] Next");
  });

  it("keeps the ID in front of an edited title and renumbers only an unstarted card", async () => {
    const { store, create } = await keyedBoard();
    await create({ title: "Spec", kind: "spec" });
    const card = await create({ title: "[LFR-21] Case data" });
    const renamed = await store.update(card.id, { title: "Case data: birth year" });
    expect(renamed.title).toBe("[LIN-1.01] Case data: birth year");
    const moved = await store.update(card.id, { release: 2, seq: 1 });
    expect(moved).toMatchObject({ title: "[LIN-2.01] Case data: birth year", release: 2, seq: 1 });

    const running = await create({ title: "Running", status: "running" });
    await expect(store.update(running.id, { seq: 9 })).rejects.toThrow("fixed once it has started");
  });

  it("changes the kind until the card starts, and a task is stored without one", async () => {
    const { store, create } = await keyedBoard();
    const card = await create({ title: "Question" });
    expect((await store.update(card.id, { kind: "research" })).kind).toBe("research");
    expect((await store.update(card.id, { kind: "task" })).kind).toBeUndefined();
    await expect(store.update(card.id, { kind: "epic" })).rejects.toThrow("card kind must be");
    const running = await create({ title: "Running", kind: "bug", status: "running" });
    await expect(store.update(running.id, { kind: "task" })).rejects.toThrow(
      "fixed once it has started",
    );
  });

  it("measures the title limit on the text, so the ID never makes a title too long", async () => {
    const { store, create } = await keyedBoard();
    const text = "x".repeat(180);
    const card = await create({ title: text });
    expect(card.title).toBe(`[LIN-1.01] ${text}`);
    const edited = await store.update(card.id, { title: `${card.title.slice(0, -1)}y` });
    expect(edited.title).toBe(`[LIN-1.01] ${"x".repeat(179)}y`);
    await expect(create({ title: "x".repeat(181) })).rejects.toThrow("180 characters");
  });

  it("routes a card by its kind as the label kind:<kind>", async () => {
    const store = createWorkboardSqliteTestStore();
    const fable = { ...NODE_TARGET, model: "anthropic/claude-fable-5-2" };
    await store.upsertBoard({
      id: "lindra",
      orchestration: {
        defaultTarget: NODE_TARGET,
        targetRoutes: [{ labels: ["kind:spec"], target: fable }],
      },
    });
    const spec = await store.create({ title: "Spec", boardId: "lindra", kind: "spec" });
    const task = await store.create({ title: "Task", boardId: "lindra" });
    expect(spec.metadata?.automation?.target).toEqual(fable);
    expect(task.metadata?.automation?.target).toEqual(NODE_TARGET);
  });

  it("numbers retros RETRO-<n> on every board, apart from the releases", async () => {
    const { store, create } = await keyedBoard();
    const spec = await create({ title: "Spec", kind: "spec" });
    const first = await create({ title: "[LIN-1.18] Retro 11-09 to 11-23", kind: "retro" });
    const ticket = await create({ title: "Ticket" });
    const plain = await store.create({ title: "[RETRO-1] Retro", kind: "retro" });
    const second = await create({ title: "Retro 11-23 to 12-07", kind: "retro" });

    expect(first).toMatchObject({ title: "[RETRO-1] Retro 11-09 to 11-23", seq: 1 });
    expect(first.release).toBeUndefined();
    expect(ticket.title).toBe(`[LIN-1.01] Ticket`);
    expect(spec.title).toBe("[LIN-1.00] Spec");
    expect(plain.title).toBe("[RETRO-1] Retro");
    expect(second.title).toBe("[RETRO-2] Retro 11-23 to 12-07");
    expect((await store.update(second.id, { title: "Retro, renamed" })).title).toBe(
      "[RETRO-2] Retro, renamed",
    );
    await expect(create({ title: "Placed", kind: "retro", seq: 5 })).rejects.toThrow(
      "numbered RETRO-<n>",
    );

    const task = await store.update(second.id, { kind: "task" });
    expect(task).toMatchObject({ title: "[LIN-1.02] Retro, renamed", release: 1, seq: 2 });
    const back = await store.update(ticket.id, { kind: "retro" });
    expect(back).toMatchObject({ title: "[RETRO-2] Ticket", seq: 2 });
    expect(back.release).toBeUndefined();
  });

  it("refuses a malformed board key", async () => {
    const store = createWorkboardSqliteTestStore();
    await expect(
      store.upsertBoard({ id: "x", name: "X", orchestration: { key: "lin" } }),
    ).rejects.toThrow("board key must be");
  });
});

describe("card kind migration", () => {
  sqliteOnly("reads spec and prototype kinds from their class labels once", async () => {
    const harness = createWorkboardSqliteTestHarness();
    const spec = await harness.store.create({ title: "Spec", labels: ["class:spec"] });
    const proto = await harness.store.create({ title: "Proto", labels: ["class:prototype"] });
    const task = await harness.store.create({ title: "Task", labels: ["class:docs"] });
    await harness.store.close();
    // The file as it was before kinds, on a physical file this process has not admitted.
    const { dbPath } = harness;
    fs.renameSync(dbPath, `${dbPath}.seed`);
    fs.copyFileSync(`${dbPath}.seed`, dbPath);
    const db = new DatabaseSync(dbPath);
    db.exec("UPDATE workboard_cards SET kind = NULL");
    db.exec("DELETE FROM workboard_schema_migrations WHERE id = 'card-kinds-from-class-labels'");
    db.close();

    const stores = createWorkboardSqliteStores({
      dbPath,
      workerModuleUrl: resolveRuntimeWorkerUrl(workboardSqliteBackendEntrypoint),
    });
    const reopened = new WorkboardStore(stores.cards, stores);
    try {
      expect((await reopened.get(spec.id))?.kind).toBe("spec");
      expect((await reopened.get(proto.id))?.kind).toBe("prototype");
      expect((await reopened.get(task.id))?.kind).toBeUndefined();
    } finally {
      await reopened.close();
    }
  });
});
