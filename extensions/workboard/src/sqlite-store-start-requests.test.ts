import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { describe, expect, vi } from "vitest";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import { syncWorkboardAgentEnded } from "./lifecycle-sync.js";
import { runSessionSweep } from "./lifecycle-sync.test-support.js";
import { createNodeGateway, NODE_TARGET, startNodeCard } from "./node-ticket.test-support.js";
import { workboardSqliteBackendEntrypoint } from "./sqlite-backend-entrypoint.test-support.js";
import { WorkboardStore } from "./store.js";
import { createWorkboardSqliteStores } from "./test/database-config.js";
import { sqliteOnly } from "./test/sqlite-only.js";
import { createWorkboardSqliteTestHarness } from "./test/sqlite-store.js";

function startRequestRows(dbPath: string, cardId: string) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT * FROM workboard_start_requests WHERE card_id = ? ORDER BY requested_at, closed_at",
      )
      .all(cardId);
  } finally {
    db.close();
  }
}

describe("start request rows", () => {
  sqliteOnly("upgrades a schema 4 file: a JSON start request becomes one open row", async () => {
    const harness = createWorkboardSqliteTestHarness();
    const node = { metadata: { automation: { target: NODE_TARGET } } };
    const queued = await harness.store.create({ title: "Queued", status: "todo", ...node });
    const limited = await harness.store.create({ title: "Limited", status: "todo", ...node });
    const plain = await harness.store.create({ title: "Plain", status: "todo", ...node });
    await harness.store.close();
    // The file as schema 4 left it, on a physical file this process has not admitted.
    const { dbPath } = harness;
    fs.renameSync(dbPath, `${dbPath}.seed`);
    fs.copyFileSync(`${dbPath}.seed`, dbPath);
    const db = new DatabaseSync(dbPath);
    const legacy = db.prepare(
      "UPDATE workboard_cards SET automation_json = json_set(automation_json, '$.startRequest', json(?)) WHERE id = ?",
    );
    legacy.run(JSON.stringify({ requestedAt: 40 }), queued.id);
    legacy.run(JSON.stringify({ requestedAt: 50, usageLimitResetsAt: 90 }), limited.id);
    db.exec(
      `DROP TABLE workboard_start_requests;
         UPDATE workboard_schema_migrations SET id = 'schema-4' WHERE id = 'schema-5';`,
    );
    db.close();

    const stores = createWorkboardSqliteStores({
      dbPath,
      workerModuleUrl: resolveRuntimeWorkerUrl(workboardSqliteBackendEntrypoint),
    });
    const reopened = new WorkboardStore(stores.cards, stores);
    try {
      expect((await reopened.get(queued.id))?.startRequest).toEqual({
        requestedAt: 40,
        source: "migrated",
      });
      expect((await reopened.get(limited.id))?.startRequest).toEqual({
        requestedAt: 50,
        source: "usage_limit_retry",
        usageLimitResetsAt: 90,
      });
      expect((await reopened.get(plain.id))?.startRequest).toBeUndefined();
    } finally {
      await reopened.close();
    }
    expect(startRequestRows(dbPath, queued.id)).toMatchObject([
      { status: "open", closed_at: null },
    ]);
    const stored = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(
        stored
          .prepare("SELECT COUNT(*) AS n FROM workboard_cards WHERE automation_json LIKE ?")
          .get("%startRequest%"),
      ).toEqual({ n: 0 });
      expect(
        stored.prepare("SELECT id FROM workboard_schema_migrations WHERE id = 'schema-5'").all(),
      ).toHaveLength(1);
    } finally {
      stored.close();
    }
  });

  sqliteOnly("cancels the open row of a card a build without the table finished", async () => {
    const harness = createWorkboardSqliteTestHarness();
    const card = await harness.store.create({
      title: "Fix the lexer",
      status: "backlog",
      metadata: { automation: { target: NODE_TARGET } },
    });
    await harness.store.requestNodeTicketStart(card.id, {
      source: "operator",
      notice: () => "Queued.",
    });
    await harness.store.close();
    const { dbPath } = harness;
    fs.renameSync(dbPath, `${dbPath}.seed`);
    fs.copyFileSync(`${dbPath}.seed`, dbPath);
    // That build reads no rows: it runs the card to done and leaves the row open.
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE workboard_cards SET status = 'done' WHERE id = ?").run(card.id);
    db.close();

    const stores = createWorkboardSqliteStores({
      dbPath,
      workerModuleUrl: resolveRuntimeWorkerUrl(workboardSqliteBackendEntrypoint),
    });
    const reopened = new WorkboardStore(stores.cards, stores);
    try {
      expect((await reopened.get(card.id))?.startRequest).toBeUndefined();
    } finally {
      await reopened.close();
    }
    const rows = startRequestRows(dbPath, card.id);
    expect(rows).toMatchObject([{ status: "cancelled" }]);
    expect(rows[0]?.closed_at).toBeTypeOf("number");
  });

  sqliteOnly(
    "keeps one open row for two starts on a full slot and closes it on the claim",
    async () => {
      const { store, dbPath } = createWorkboardSqliteTestHarness();
      store.nodeTicketConcurrency = 1;
      await startNodeCard(store);
      const card = await store.create({
        title: "Fix the lexer",
        status: "todo",
        metadata: { automation: { target: NODE_TARGET } },
      });
      const start = () =>
        dispatchAndStartWorkboardCards({
          store,
          subagent: { run: vi.fn() },
          nodeTickets: createNodeGateway(),
          options: { cardId: card.id, maxStarts: 1, queue: "request" },
        });

      const first = await start();
      const second = await start();

      const requestedAt = first.queued?.startRequest?.requestedAt;
      expect(requestedAt).toBeTypeOf("number");
      expect(second.queued?.startRequest?.requestedAt).toBe(requestedAt);
      expect(startRequestRows(dbPath, card.id)).toMatchObject([
        {
          status: "open",
          source: "operator",
          requested_at: requestedAt,
          closed_at: null,
        },
      ]);

      store.nodeTicketConcurrency = 2;
      const claimed = await start();

      expect(claimed.started).toHaveLength(1);
      const running = await store.get(card.id);
      expect(running?.startRequest).toBeUndefined();
      const rows = startRequestRows(dbPath, card.id);
      expect(rows).toMatchObject([{ status: "claimed", requested_at: requestedAt }]);
      expect(rows[0]?.claimed_at).toBeTypeOf("number");
      expect(rows[0]?.closed_at).toBe(rows[0]?.claimed_at);
    },
  );

  sqliteOnly(
    "cancels the row on a move away or an archive and keeps a card's last 20 closed rows",
    async () => {
      const { store, dbPath } = createWorkboardSqliteTestHarness();
      const card = await store.create({
        title: "Fix the lexer",
        status: "backlog",
        metadata: { automation: { target: NODE_TARGET } },
      });
      const queue = () =>
        store.requestNodeTicketStart(card.id, { source: "operator", notice: () => "Queued." });

      const first = (await queue()).card.startRequest?.requestedAt;
      const moved = await store.move(card.id, "backlog", undefined);
      expect(moved.startRequest).toBeUndefined();
      expect(startRequestRows(dbPath, card.id)).toMatchObject([
        { status: "cancelled", requested_at: first, claimed_at: null, closed_at: moved.updatedAt },
      ]);

      await queue();
      const archived = await store.archive(card.id, true);
      expect(archived.startRequest).toBeUndefined();
      expect(startRequestRows(dbPath, card.id).map((row) => row.status)).toEqual([
        "cancelled",
        "cancelled",
      ]);
      await store.archive(card.id, false);

      for (let round = 0; round < 20; round++) {
        await queue();
        await store.move(card.id, "backlog", undefined);
      }
      const rows = startRequestRows(dbPath, card.id);
      expect(rows).toHaveLength(20);
      // The two oldest closed rows went; the first request was one of them.
      expect(rows.every((row) => row.status === "cancelled")).toBe(true);
      expect(Number(rows[0]?.closed_at)).toBeGreaterThan(archived.updatedAt);
    },
  );

  sqliteOnly(
    "stores a usage limit requeue's reset as the row's wait and reads it back",
    async () => {
      // 22:50 in Berlin; the Claude CLI's limit resets at 23:10 there.
      vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-11-25T21:50:00Z") });
      try {
        const { store, dbPath } = createWorkboardSqliteTestHarness();
        const { card, sessionKey, runId } = await startNodeCard(store);
        const limit = "You've hit your session limit · resets 11:10pm (Europe/Berlin)";
        await syncWorkboardAgentEnded({
          store,
          event: { runId, success: false, error: limit, messages: [] },
          context: { runId, sessionKey },
          readSessions: async () => ({
            sessions: [{ key: sessionKey, status: "running" as const, hasActiveRun: true }],
            complete: true,
          }),
        });
        await runSessionSweep({
          store,
          sessions: [
            { key: sessionKey, status: "failed", hasActiveRun: false, updatedAt: Date.now() + 1 },
          ],
        });

        const resetsAt = Date.parse("2026-11-25T22:10:00Z");
        const requeued = await store.get(card.id);
        expect(requeued?.startRequest).toEqual({
          requestedAt: expect.any(Number),
          source: "usage_limit_retry",
          usageLimitResetsAt: resetsAt,
        });
        expect(startRequestRows(dbPath, card.id)).toMatchObject([
          {
            status: "open",
            source: "usage_limit_retry",
            wait_kind: "usage_limit",
            wait_until: resetsAt,
          },
        ]);
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
