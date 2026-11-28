import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  openEngineStore,
  withEngineStoreAdmission,
  type EngineConnection,
  type DatabaseEngineInput,
} from "openclaw/plugin-sdk/database-engine-worker-runtime";
import {
  configureSqliteConnectionPragmas,
  migrateSqliteSchemaToStrict,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  getSqliteDatabaseAdmission,
  openNodeSqliteDatabase,
  publishSqliteDatabaseAdmission,
  admitSqliteSchema,
  getAdmittedSqliteSchemaFacts,
  type SqliteDatabaseAdmissionKey,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import {
  cancelStaleStartRequests,
  migrateStartRequestsFromAutomationJson,
} from "./sqlite-store-start-requests.js";
import { workboardEngineSchema } from "./store-engine-schema.js";
import { SCHEMA_VERSION, WORKBOARD_SCHEMA_SQL } from "./workboard-schema.js";
export type WorkboardSqlConnection = EngineConnection;

const WORKBOARD_SQLITE_BUSY_TIMEOUT_MS = 5000;
const WORKBOARD_SQLITE_DIR_MODE = 0o700;
const WORKBOARD_SQLITE_FILE_MODE = 0o600;
const schemaAdmission: SqliteDatabaseAdmissionKey<true> = {
  name: "workboard.schema",
  schemaDependent: true,
  read: (value) => (value === true ? true : undefined),
};

function tableColumns(db: DatabaseSync, tableName: string): Set<string> {
  return new Set(
    db
      .prepare(`PRAGMA table_info(${tableName})`)
      .all()
      .flatMap((row) => (typeof row.name === "string" ? [row.name] : [])),
  );
}

function ensureColumn(db: DatabaseSync, tableName: string, columnName: string, definition: string) {
  if (tableColumns(db, tableName).has(columnName)) {
    return;
  }
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${definition}`);
}

const CARD_KINDS_MIGRATION_ID = "card-kinds-from-class-labels";

/**
 * Data-move markers this store records beside its `schema-N` markers. They
 * change no schema, so a database port accepts them without a version.
 */
export const WORKBOARD_DATA_MIGRATION_IDS: ReadonlySet<string> = new Set([CARD_KINDS_MIGRATION_ID]);

// Before card kinds, spec and prototype cards were told apart only by their
// `class:spec` / `class:prototype` label. The labels stay; the kind is read
// from them once.
function migrateCardKindsFromClassLabels(db: DatabaseSync): void {
  if (
    db
      .prepare("SELECT 1 AS found FROM workboard_schema_migrations WHERE id = ?")
      .get(CARD_KINDS_MIGRATION_ID)
  ) {
    return;
  }
  const setKind = db.prepare(
    `UPDATE workboard_cards SET kind = ? WHERE kind IS NULL AND id IN
       (SELECT card_id FROM workboard_card_labels WHERE label = ?)`,
  );
  setKind.run("spec", "class:spec");
  setKind.run("prototype", "class:prototype");
  db.prepare(
    "INSERT OR IGNORE INTO workboard_schema_migrations (id, applied_at) VALUES (?, ?)",
  ).run(CARD_KINDS_MIGRATION_ID, Date.now());
}

function ensureWorkboardSchema(db: DatabaseSync): void {
  if (getSqliteDatabaseAdmission(db, schemaAdmission)) {
    return;
  }
  db.exec(WORKBOARD_SCHEMA_SQL);
  ensureColumn(db, "workboard_boards", "automation_job_id", "automation_job_id TEXT");
  ensureColumn(db, "workboard_boards", "kind", "kind TEXT");
  ensureColumn(db, "workboard_boards", "sessions_spec", "sessions_spec TEXT");
  ensureColumn(db, "workboard_card_comments", "source", "source TEXT");
  ensureColumn(db, "workboard_card_attempts", "context_tokens", "context_tokens INTEGER");
  ensureColumn(db, "workboard_cards", "kind", "kind TEXT");
  ensureColumn(db, "workboard_cards", "release", "release INTEGER");
  ensureColumn(db, "workboard_cards", "seq", "seq INTEGER");
  migrateCardKindsFromClassLabels(db);
  const migrationId = `schema-${SCHEMA_VERSION}`;
  const current = db
    .prepare("SELECT 1 AS found FROM workboard_schema_migrations WHERE id = ?")
    .get(migrationId);
  if (!current) {
    migrateStartRequestsFromAutomationJson(db);
    migrateSqliteSchemaToStrict(db, WORKBOARD_SCHEMA_SQL, {
      databaseLabel: "workboard database",
    });
    db.prepare(
      "INSERT OR IGNORE INTO workboard_schema_migrations (id, applied_at) VALUES (?, ?)",
    ).run(migrationId, Date.now());
  }
  cancelStaleStartRequests(db);
  publishSqliteDatabaseAdmission(db, schemaAdmission, true);
}

function chmodIfExists(targetPath: string, mode: number): void {
  try {
    fs.chmodSync(targetPath, mode);
  } catch (err) {
    // SAFETY: chmodSync reports filesystem failures as Node errno exceptions.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}

function hardenWorkboardDatabaseFiles(dbPath: string): void {
  fs.chmodSync(path.dirname(dbPath), WORKBOARD_SQLITE_DIR_MODE);
  chmodIfExists(dbPath, WORKBOARD_SQLITE_FILE_MODE);
  chmodIfExists(`${dbPath}-wal`, WORKBOARD_SQLITE_FILE_MODE);
  chmodIfExists(`${dbPath}-shm`, WORKBOARD_SQLITE_FILE_MODE);
  chmodIfExists(`${dbPath}-journal`, WORKBOARD_SQLITE_FILE_MODE);
}

function prepareWorkboardDatabasePath(dbPath: string): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: WORKBOARD_SQLITE_DIR_MODE });
  chmodIfExists(path.dirname(dbPath), WORKBOARD_SQLITE_DIR_MODE);
  if (!fs.existsSync(dbPath)) {
    fs.closeSync(fs.openSync(dbPath, "a", WORKBOARD_SQLITE_FILE_MODE));
  }
}

export function createWorkboardDatabase(
  dbPath: string,
  retainClose?: (close: () => void) => void,
  postgresInput?: DatabaseEngineInput,
): {
  db: WorkboardSqlConnection;
  close: () => void;
} {
  prepareWorkboardDatabasePath(dbPath);
  const db = openNodeSqliteDatabase(dbPath);
  let selected: EngineConnection | undefined;
  let maintenance: ReturnType<typeof configureSqliteConnectionPragmas> | undefined;
  let maintenanceClosed = false;
  let databaseClosed = false;
  const close = () => {
    if (selected && selected !== db) {
      selected.close();
    }
    if (!maintenanceClosed) {
      maintenance?.close();
      maintenanceClosed = true;
    }
    if (!databaseClosed) {
      db.close();
      databaseClosed = true;
    }
  };
  try {
    retainClose?.(close);
    selected = withEngineStoreAdmission(() =>
      openEngineStore({
        anchor: db,
        schema: workboardEngineSchema,
        input: postgresInput,
        inspectSqlite: () => {
          admitSqliteSchema(db);
          const facts = getAdmittedSqliteSchemaFacts(db);
          if (!facts) {
            throw new Error("Workboard SQLite catalog admission is unavailable");
          }
          return {
            hasEngineAnchor: facts.tables.has("openclaw_engine_anchor"),
            hasExistingData:
              [...facts.tables].some(
                (name) => name !== "openclaw_engine_anchor" && !name.startsWith("sqlite_"),
              ) ||
              facts.views.size > 0 ||
              facts.triggers.size > 0,
          };
        },
        prepareAnchor: () => {
          maintenance = configureSqliteConnectionPragmas(db, {
            busyTimeoutMs: WORKBOARD_SQLITE_BUSY_TIMEOUT_MS,
            checkpointIntervalMs: 0,
            databaseLabel: "workboard database",
            databasePath: dbPath,
            foreignKeys: true,
            synchronous: "NORMAL",
          });
        },
        openSqlite: () => ensureWorkboardSchema(db),
      }),
    );
    hardenWorkboardDatabaseFiles(dbPath);
    return { db: selected, close };
  } catch (error) {
    if (!retainClose) {
      try {
        if (selected && selected !== db) {
          selected.close();
        }
        maintenance?.close();
      } finally {
        db.close();
      }
    }
    throw error;
  }
}
