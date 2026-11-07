import { expect, it } from "vitest";
import { runWithSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { cronRunRecordToRunLogEntry } from "../run-history-detail.js";
import type { CronStoredJob } from "../types.js";
import { loadCronRows, loadedCronStoreFromRows, upsertCronJobRow } from "./row-codec.js";
import { readCronRunRecordsInDatabase } from "./run-history.kernel.js";
import { recordCronFailureAlertOutcomeInWorker } from "./runtime-maintenance.worker.js";

const STORE_KEY = "/state/cron/jobs.json";
const JOB_ID = "job-1";
const RUN_AT_MS = 50_000;
const ALERT_AT_MS = 50_500;
const NOTIFICATION_ID = "alert-1";

it("records a settled failure-alert outcome on the run's history row, not only on the job", async () => {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "cron-alert-outcome-" },
    async (state) => {
      const database = openOpenClawStateDatabase();
      const job: CronStoredJob = {
        id: JOB_ID,
        name: "review",
        agentId: "dev",
        enabled: true,
        createdAtMs: 1,
        updatedAtMs: 1,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "review" },
        failureAlert: { after: 1, channel: "signal", to: "+15550100" },
        state: {
          lastRunAtMs: RUN_AT_MS,
          lastStatus: "error",
          lastFailureAlertAtMs: ALERT_AT_MS,
          lastFailureNotificationId: NOTIFICATION_ID,
          lastFailureNotificationDeliveryStatus: "unknown",
        },
      };
      upsertCronJobRow(database.db, STORE_KEY, job, 0);
      // The run's history row is written at finalization, before the alert settles.
      database.db
        .prepare(
          "INSERT INTO task_runs (task_id, runtime, source_id, run_id, owner_key, scope_kind, task, delivery_status, notify_policy, created_at, started_at, ended_at, status, detail_json) VALUES (?, 'cron', ?, ?, '', 'system', ?, 'not_applicable', 'silent', ?, ?, ?, 'failed', ?)",
        )
        .run(
          "run-row",
          JOB_ID,
          `cron:${JOB_ID}:${RUN_AT_MS}:terminal`,
          JOB_ID,
          RUN_AT_MS,
          RUN_AT_MS,
          RUN_AT_MS + 1_000,
          JSON.stringify({
            kind: "cron-run",
            storeKey: STORE_KEY,
            status: "error",
            completionStatus: "failed",
            error: "provider unavailable",
            runAtMs: RUN_AT_MS,
            failureNotificationDelivery: { status: "unknown" },
          }),
        );
      const historyDelivery = () =>
        readCronRunRecordsInDatabase(database.db, JOB_ID).map(
          (row) => cronRunRecordToRunLogEntry(row)?.failureNotificationDelivery,
        );
      const jobDelivery = () => {
        const rows = loadCronRows(database.db, STORE_KEY, new Set([JOB_ID]));
        const stored = loadedCronStoreFromRows(rows).store.jobs[0]?.state;
        return {
          status: stored?.lastFailureNotificationDeliveryStatus,
          delivered: stored?.lastFailureNotificationDelivered,
        };
      };
      expect(historyDelivery()).toEqual([{ status: "unknown" }]);

      const record = (notificationId: string) =>
        runWithSqliteWorkerStateContext(
          { environment: { OPENCLAW_STATE_DIR: state.stateDir } },
          () =>
            recordCronFailureAlertOutcomeInWorker(database, {
              storeKey: STORE_KEY,
              jobId: JOB_ID,
              runAtMs: RUN_AT_MS,
              alertAtMs: ALERT_AT_MS,
              notificationId,
              outcome: { delivered: true, status: "delivered" },
            }),
        );

      // A stale cycle owns neither the job row nor the run's history.
      expect(record("alert-0").outcome.job).toBeUndefined();
      expect(jobDelivery()).toEqual({ status: "unknown", delivered: undefined });
      expect(historyDelivery()).toEqual([{ status: "unknown" }]);

      expect(record(NOTIFICATION_ID).outcome.job?.state).toMatchObject({
        lastFailureNotificationDeliveryStatus: "delivered",
        lastFailureNotificationDelivered: true,
      });
      expect(jobDelivery()).toEqual({ status: "delivered", delivered: true });
      expect(historyDelivery()).toEqual([{ status: "delivered", delivered: true }]);
    },
  );
});
