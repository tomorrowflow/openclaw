import "./isolated-agent.mocks.js";
import path from "node:path";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { createCliDeps, mockAgentPayloads } from "./isolated-agent.delivery.test-helpers.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent.js";
import { makeCfg, makeJob, withTempCronHome } from "./isolated-agent.test-harness.js";
import { setupIsolatedAgentTurnMocks } from "./isolated-agent.test-setup.js";
import { TEST_SCHEDULED_OCCURRENCE } from "./scheduled-occurrence.test-support.js";

const MIGRATED_JOB_ID = "heartbeat-main";

// mock-isolation: Receipt ownership lives in the shared-state database; select the migrated job by id.
vi.mock("../infra/heartbeat-compat.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/heartbeat-compat.js")>()),
  isLegacyHeartbeatJob: async (_cfg: unknown, jobId: string) => jobId === MIGRATED_JOB_ID,
}));

async function announce(text: string, jobId: string) {
  return withTempCronHome(async (home) => {
    const cfg = makeCfg(home, path.join(home, ".openclaw", "sessions", "sessions.json"));
    setRuntimeConfigSnapshot(cfg);
    const deps = createCliDeps();
    mockAgentPayloads([{ text }]);
    const result = await runCronIsolatedAgentTurn({
      occurrence: TEST_SCHEDULED_OCCURRENCE,
      deliveryAttemptFence: null,
      cfg,
      deps,
      job: {
        ...makeJob({ kind: "agentTurn", message: "do it" }),
        id: jobId,
        delivery: { mode: "announce", channel: "telegram", to: "123" },
      },
      message: "do it",
      sessionKey: `cron:${jobId}`,
      lane: "cron",
    });
    return { result, deps };
  });
}

beforeAll(async () => {
  setupIsolatedAgentTurnMocks();
  await announce("warm runtime", "warm");
});
beforeEach(() => setupIsolatedAgentTurnMocks());

it("treats short prose plus trailing NO_REPLY as an acknowledgement for a migrated heartbeat", async () => {
  const { result, deps } = await announce(
    "Checked the list, nothing new.\nNO_REPLY",
    MIGRATED_JOB_ID,
  );
  expect(result.status).toBe("ok");
  expect(result.delivered).toBeFalsy();
  expect(deps.telegram).not.toHaveBeenCalled();
});

it("keeps upstream delivery of the same text on an ordinary automation", async () => {
  const { result, deps } = await announce(
    "Checked the list, nothing new.\nNO_REPLY",
    "ordinary-job",
  );
  expect(result).toMatchObject({ status: "ok", delivered: true });
  expect(deps.telegram).toHaveBeenCalledOnce();
});

it("still delivers a migrated heartbeat whose prose exceeds the ack threshold", async () => {
  const { result, deps } = await announce(
    `${"Something happened. ".repeat(30)}\nNO_REPLY`,
    MIGRATED_JOB_ID,
  );
  expect(result).toMatchObject({ status: "ok", delivered: true });
  expect(deps.telegram).toHaveBeenCalledOnce();
});
