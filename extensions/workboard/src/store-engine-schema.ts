import {
  postgresIndexOrderingMigration,
  withLegacyPostgresIndexOrdering,
  type StoreSchema,
} from "openclaw/plugin-sdk/database-engine-worker-runtime";
import { WORKBOARD_POSTGRES_SCHEMA_SQL } from "./workboard-postgres-schema.js";
import { SCHEMA_VERSION, WORKBOARD_SCHEMA_SQL } from "./workboard-schema.js";

// Schema 5 added the start request table. Generated DDL is one statement per
// block, and each of the table's statements names it on its first line.
const statements = WORKBOARD_POSTGRES_SCHEMA_SQL.split("\n\n");
const ownsStartRequests = (statement: string) =>
  /^(?:CREATE|ALTER) [^\n]*"workboard_start_requests"/.test(statement);
const postgresV4Sql = statements.filter((statement) => !ownsStartRequests(statement)).join("\n\n");

// A stored timestamp is a non-negative JSON number, as the SQLite move reads it.
const storedMs = (field: string) => {
  const value = `("automation_json"::jsonb #> '{startRequest,${field}}')`;
  return `CASE WHEN jsonb_typeof(${value}) = 'number'
      AND (${value} #>> '{}')::numeric BETWEEN 0 AND 9007199254740991
    THEN trunc((${value} #>> '{}')::numeric)::bigint END`;
};

/** The PostgreSQL form of `migrateStartRequestsFromAutomationJson`. */
const startRequestsFromAutomationJsonSql = `
  INSERT INTO "workboard_start_requests"
    ("id", "card_id", "source", "status", "requested_at", "wait_kind", "wait_until")
  SELECT gen_random_uuid()::text, "id",
    CASE WHEN resets_at IS NULL THEN 'migrated' ELSE 'usage_limit_retry' END,
    'open', requested_at,
    CASE WHEN resets_at IS NULL THEN NULL ELSE 'usage_limit' END, resets_at
  FROM (
    SELECT "id", ${storedMs("requestedAt")} AS requested_at,
      ${storedMs("usageLimitResetsAt")} AS resets_at
    FROM "workboard_cards"
    WHERE jsonb_exists("automation_json"::jsonb, 'startRequest')
  ) AS stored
  WHERE requested_at IS NOT NULL;
  UPDATE "workboard_cards"
  SET "automation_json" = NULLIF(("automation_json"::jsonb - 'startRequest')::text, '{}')
  WHERE jsonb_exists("automation_json"::jsonb, 'startRequest');`;

export const workboardEngineSchema: StoreSchema = {
  id: "workboard",
  version: SCHEMA_VERSION,
  sqlite: WORKBOARD_SCHEMA_SQL,
  postgres: WORKBOARD_POSTGRES_SCHEMA_SQL,
  postgresMigrations: [
    {
      version: 4,
      fromSchema: { postgres: withLegacyPostgresIndexOrdering(postgresV4Sql) },
      schema: { postgres: postgresV4Sql },
      sql: postgresIndexOrderingMigration(postgresV4Sql),
    },
    {
      version: 5,
      fromSchema: { postgres: postgresV4Sql },
      schema: { postgres: WORKBOARD_POSTGRES_SCHEMA_SQL },
      sql: `${statements.filter(ownsStartRequests).join("\n")}\n${startRequestsFromAutomationJsonSql}`,
    },
  ],
};
