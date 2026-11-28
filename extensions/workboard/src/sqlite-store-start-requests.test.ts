import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { describe, expect, vi } from "vitest";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
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
      .prepare("SELECT * FROM workboard_start_requests WHERE card_id = ? ORDER BY requested_at")
      .all(cardId);
  } finally {
    db.close();
  }
}

describe("start request rows", () => {
  sqliteOnly(
    "moves a start request stored in a card's automation JSON to one open row",
    async () => {
      const harness = createWorkboardSqliteTestHarness();
      const node = { metadata: { automation: { target: NODE_TARGET } } };
      const queued = await harness.store.create({ title: "Queued", status: "todo", ...node });
      const limited = await harness.store.create({ title: "Limited", status: "todo", ...node });
      const plain = await harness.store.create({ title: "Plain", status: "todo", ...node });
      await harness.store.close();
      // The file as it was before the table, on a physical file this process has not admitted.
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
        "DELETE FROM workboard_schema_migrations WHERE id = 'start-requests-from-automation-json'",
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
      } finally {
        stored.close();
      }
    },
  );

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
          coalesced_count: 0,
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
});
