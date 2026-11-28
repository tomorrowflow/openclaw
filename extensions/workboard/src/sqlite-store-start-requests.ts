import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  WorkboardCard,
  WorkboardStartRequest,
  WorkboardStartRequestSource,
} from "@openclaw/workboard-contract";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
  runSqliteImmediateTransactionSync,
  sqliteStringSet,
  type Generated,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { definedFields } from "../record-fields.js";
import type { WorkboardSqlConnection } from "./sqlite-store-schema.js";

type Row = Record<string, unknown>;

/**
 * One row per start request. A row is live while `closed_at` is null, and a
 * card has at most one live row (`workboard_start_requests_open_idx`). The
 * live row is the card's `startRequest`; closed rows are the card's history.
 */
type StartRequestRow = {
  id: string;
  card_id: string;
  source: WorkboardStartRequestSource;
  status: "open" | "claimed" | "cancelled";
  requested_at: number;
  /** What the request waits on. Only a usage limit records it so far. */
  wait_kind: "usage_limit" | null;
  wait_until: number | null;
  coalesced_count: Generated<number>;
  claimed_at: number | null;
  claimed_run_id: string | null;
  closed_at: number | null;
};
type StartRequestDatabase = { workboard_start_requests: StartRequestRow };

// Closed rows per card kept as history; a card's rows go with the card.
const MAX_CLOSED_START_REQUESTS_PER_CARD = 20;

function decodeStartRequest(row: Row): WorkboardStartRequest {
  return definedFields<WorkboardStartRequest>({
    requestedAt: Number(row.requested_at),
    // SAFETY: syncStartRequest persists WorkboardStartRequest.source unchanged.
    source: row.source as WorkboardStartRequestSource,
    usageLimitResetsAt:
      row.wait_kind === "usage_limit" && row.wait_until !== null
        ? Number(row.wait_until)
        : undefined,
  });
}

/** The live start request of every selected card, or of every card. */
export function loadOpenStartRequests(
  db: WorkboardSqlConnection,
  cardIds?: string[],
): Map<string, WorkboardStartRequest> {
  let query = getNodeSqliteKysely<StartRequestDatabase>(db)
    .selectFrom("workboard_start_requests")
    .select(["card_id", "source", "requested_at", "wait_kind", "wait_until"])
    .where("closed_at", "is", null);
  if (cardIds) {
    query = query.where("card_id", "in", sqliteStringSet(cardIds));
  }
  return new Map(
    Array.from(iterateSqliteQuerySync(db, query), (row) => [row.card_id, decodeStartRequest(row)]),
  );
}

/**
 * Brings a card's rows in line with the card being written, in the write's
 * transaction. A request on the card is its live row, opened on first sight.
 * A card without one closes its live row: `claimed` when the write carries a
 * claim, `cancelled` when the card was moved away or archived.
 */
export function syncStartRequest(db: WorkboardSqlConnection, card: WorkboardCard): void {
  const query = getNodeSqliteKysely<StartRequestDatabase>(db);
  const request = card.startRequest;
  if (request) {
    const values = {
      source: request.source,
      requested_at: request.requestedAt,
      wait_kind: request.usageLimitResetsAt === undefined ? null : ("usage_limit" as const),
      wait_until: request.usageLimitResetsAt ?? null,
    };
    executeSqliteQuerySync(
      db,
      query
        .insertInto("workboard_start_requests")
        .values({ id: randomUUID(), card_id: card.id, status: "open", ...values })
        .onConflict((conflict) =>
          conflict.column("card_id").where("closed_at", "is", null).doUpdateSet(values),
        ),
    );
    return;
  }
  // A claim moves a queued card to running; a leftover claim on a card moved away is no start.
  const claimed = card.status === "running" && card.metadata?.claim !== undefined;
  const closed = executeSqliteQuerySync(
    db,
    query
      .updateTable("workboard_start_requests")
      .set({
        status: claimed ? "claimed" : "cancelled",
        claimed_at: claimed ? card.updatedAt : null,
        closed_at: card.updatedAt,
      })
      .where("card_id", "=", card.id)
      .where("closed_at", "is", null),
  );
  if (!closed.numAffectedRows) {
    return;
  }
  executeSqliteQuerySync(
    db,
    query
      .deleteFrom("workboard_start_requests")
      .where("card_id", "=", card.id)
      .where("closed_at", "is not", null)
      .where("id", "not in", (eb) =>
        eb
          .selectFrom("workboard_start_requests")
          .select("id")
          .where("card_id", "=", card.id)
          .where("closed_at", "is not", null)
          .orderBy("closed_at", "desc")
          .orderBy("id", "desc")
          .limit(MAX_CLOSED_START_REQUESTS_PER_CARD),
      ),
  );
}

/**
 * Before the table, a queued start was `startRequest` inside a card's
 * `automation_json`. Each becomes the card's live row once, and the JSON
 * loses the field. A request that named a usage-limit reset came from a
 * usage-limit retry; any other one recorded no source.
 */
export function migrateStartRequestsFromAutomationJson(db: DatabaseSync): void {
  const migrationId = "start-requests-from-automation-json";
  if (
    db.prepare("SELECT 1 AS found FROM workboard_schema_migrations WHERE id = ?").get(migrationId)
  ) {
    return;
  }
  const timestamp = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? Math.trunc(value)
      : undefined;
  runSqliteImmediateTransactionSync(db, () => {
    const cards = db
      .prepare(
        `SELECT id, automation_json FROM workboard_cards WHERE automation_json LIKE '%"startRequest"%'`,
      )
      .all();
    const insert = db.prepare(
      `INSERT INTO workboard_start_requests
         (id, card_id, source, status, requested_at, wait_kind, wait_until)
       VALUES (?, ?, ?, 'open', ?, ?, ?)`,
    );
    const strip = db.prepare("UPDATE workboard_cards SET automation_json = ? WHERE id = ?");
    for (const card of cards) {
      // SAFETY: insertCard serialized automation_json as a JSON object.
      const automation = JSON.parse(String(card.automation_json)) as Record<string, unknown>;
      if (!Object.hasOwn(automation, "startRequest")) {
        continue;
      }
      const { startRequest, ...rest } = automation;
      // SAFETY: a stored start request is an object; a malformed one is dropped, as its normalizer did.
      const stored = (startRequest ?? {}) as Record<string, unknown>;
      const requestedAt = timestamp(stored.requestedAt);
      if (requestedAt !== undefined) {
        const resetsAt = timestamp(stored.usageLimitResetsAt);
        insert.run(
          randomUUID(),
          String(card.id),
          resetsAt === undefined ? "migrated" : "usage_limit_retry",
          requestedAt,
          resetsAt === undefined ? null : "usage_limit",
          resetsAt ?? null,
        );
      }
      strip.run(Object.keys(rest).length ? JSON.stringify(rest) : null, String(card.id));
    }
    db.prepare(
      "INSERT OR IGNORE INTO workboard_schema_migrations (id, applied_at) VALUES (?, ?)",
    ).run(migrationId, Date.now());
  });
}
