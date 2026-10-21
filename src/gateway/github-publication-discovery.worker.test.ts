import "../test-utils/prepare-compiled-subprocesses.js";
import path from "node:path";
import { afterAll, afterEach, expect, it } from "vitest";
import {
  createRestartRecoveryStoreFixture,
  mainSessionEntry,
} from "../agents/main-session-recovery/main-session-restart-recovery-fixture.test-support.js";
import { markStartupOrphanedMainSessionsForRecovery } from "../agents/main-session-recovery/main-session-restart-recovery.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/io.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { startGitHubPublicationDiscovery } from "./github-publication-discovery.js";

const tempDirs = useSessionStoreTempDirs(afterAll, "openclaw-publication-discovery-");
let stateDir = "";
const { makeSessionsDir, writeStore } = createRestartRecoveryStoreFixture(() => stateDir);

afterEach(() => clearRuntimeConfigSnapshot());

it("leaves target-discovery capacity for startup orphan marking while refreshing every projected row", async () => {
  stateDir = tempDirs.make();
  const sessionsDir = await makeSessionsDir();
  const storePath = path.join(sessionsDir, "sessions.json");
  await writeStore(sessionsDir, { "agent:main:main": mainSessionEntry({}) });
  const cfg = { session: { store: storePath } };
  setRuntimeConfigSnapshot(cfg);
  await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
    // More rows than the shared target-discovery lane admits (128 pending tasks).
    const rows = Array.from({ length: 200 }, (_, index) => ({
      key: `agent:main:row-${index}`,
      agentId: "main",
      entry: { sessionId: `session-${index}`, updatedAt: 1, repositoryWorkspaceId: "workspace" },
    }));
    const clock = createGatewaySchedulerClock(1_000);
    const scheduler = createTestGatewayScheduler(clock.clock);
    const owner = startGitHubPublicationDiscovery({
      scheduler,
      projection: {
        ensureMaterialized: async () => {},
        selectEntries: () => rows,
        onSelectionChange: () => {},
      },
    });
    try {
      // The startup pass schedules one refresh per row; the next wake dispatches them all.
      await clock.wake();
      const refreshes = clock.wake();
      await expect(
        markStartupOrphanedMainSessionsForRecovery({ cfg, stateDir }),
      ).resolves.toMatchObject({ marked: 0 });
      await refreshes;
    } finally {
      await owner.stop();
      await scheduler.stop();
    }
  });
});
