import { describe, expect, it, vi } from "vitest";
import { createDueIsolatedJob } from "../../../test/helpers/cron/service-regression-fixtures.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { CronService, type CronEvent } from "../../cron/service.js";
import { createNoopLogger } from "../../cron/service.test-harness.js";
import { saveCronStore } from "../../cron/store.js";
import {
  enqueueCommandInLane,
  getTotalQueueSize,
  setCommandLaneConcurrency,
} from "../../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { CommandLane } from "../../process/lanes.js";
import { AsyncWorkScope, trackAsyncWork } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";

describe("queued manual cron runs", () => {
  it("own their execution after the enqueuing caller's work scope closes", async () => {
    await withOpenClawTestState({ prefix: "cron-caller-scope-" }, async (state) => {
      resetCommandQueueStateForTest();
      const cfg: OpenClawConfig = {
        agents: { entries: { main: {} }, defaults: { workspace: state.workspaceDir } },
        cron: { enabled: false },
      };
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      const storePath = state.statePath("cron", "jobs.json");
      const now = Date.now();
      const job = createDueIsolatedJob({ id: "nudged-review", nowMs: now, nextRunAtMs: now });
      await saveCronStore(storePath, { version: 1, jobs: [job] });
      const finished = createDeferredCore<CronEvent>();
      // The isolated run tracks its own async work, as agent runs do.
      const runIsolatedAgentJob = vi.fn(async () => {
        await trackAsyncWork(async () => undefined);
        return { status: "ok" as const };
      });
      const cron = new CronService({
        scheduler: createTestGatewayScheduler(),
        storePath,
        cronEnabled: false,
        defaultAgentId: "main",
        log: createNoopLogger(),
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob,
        onEvent: (event) => {
          if (event.action === "finished") {
            finished.resolve(event);
          }
        },
      });
      setCommandLaneConcurrency(CommandLane.Cron, 1);
      const releaseBlocker = createDeferredCore();
      const blockerStarted = createDeferredCore();
      const blocker = enqueueCommandInLane(CommandLane.Cron, async () => {
        blockerStarted.resolve();
        await releaseBlocker.promise;
      });
      await blockerStarted.promise;
      try {
        // A plugin hook (e.g. a Workboard automation nudge at agent_end) enqueues
        // the run from a turn whose work scope closes right after the ack.
        const caller = new AsyncWorkScope();
        const ack = await caller.track(() => cron.enqueueRun(job.id, "force"));
        expect(ack).toMatchObject({ ok: true, enqueued: true });
        await caller.drain();

        releaseBlocker.resolve();
        await blocker;
        const terminal = await finished.promise;
        expect(terminal.error).toBeUndefined();
        expect(terminal).toMatchObject({ status: "ok" });
        expect(runIsolatedAgentJob).toHaveBeenCalledOnce();
      } finally {
        releaseBlocker.resolve();
        cron.stop();
        await vi.waitFor(() => expect(getTotalQueueSize()).toBe(0));
        resetCommandQueueStateForTest();
      }
    });
  });
});
