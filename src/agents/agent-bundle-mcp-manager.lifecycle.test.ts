import { afterEach, describe, expect, it } from "vitest";
import {
  createSessionMcpRuntimeManager,
  makeManagerRuntime,
} from "./agent-bundle-mcp-manager.test-support.js";
import type { CreateSessionMcpRuntime } from "./agent-bundle-mcp-runtime-shared.js";
import type { SessionMcpRuntime } from "./agent-bundle-mcp-types.js";

const managers: ReturnType<typeof createSessionMcpRuntimeManager>[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.disposeAll()));
});

function createRuntimeFixture(input: Parameters<CreateSessionMcpRuntime>[0]): SessionMcpRuntime {
  return makeManagerRuntime(input, undefined, { callTool: async () => ({ content: [] }) });
}

function createManager() {
  const manager = createSessionMcpRuntimeManager({ createRuntime: createRuntimeFixture });
  managers.push(manager);
  return manager;
}

describe("MCP manager session key rollover", () => {
  const rolloverParams = (sessionId: string) => ({
    sessionId,
    sessionKey: "agent:test:main:heartbeat",
    workspaceDir: "/workspace",
    agentDir: "/agents/test",
    cfg: { mcp: { servers: { fixture: { command: "true" } } } },
    manifestRegistry: { plugins: [] },
  });

  it("retires the superseded runtime when a session key rolls to a fresh session id", async () => {
    const manager = createManager();
    const first = await manager.getOrCreate(rolloverParams("heartbeat-run-1"));
    const second = await manager.getOrCreate(rolloverParams("heartbeat-run-2"));

    expect(second).not.toBe(first);
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(second.dispose).not.toHaveBeenCalled();
    expect(manager.listSessionIds()).toEqual(["heartbeat-run-2"]);
    expect(manager.resolveSessionId("agent:test:main:heartbeat")).toBe("heartbeat-run-2");
  });

  it("keeps the superseded runtime until its active lease releases", async () => {
    const manager = createManager();
    const firstLease = await manager.acquire(rolloverParams("heartbeat-run-1"));
    const second = await manager.getOrCreate(rolloverParams("heartbeat-run-2"));

    expect(firstLease.runtime.dispose).not.toHaveBeenCalled();
    expect(manager.listSessionIds().toSorted()).toEqual(["heartbeat-run-1", "heartbeat-run-2"]);

    firstLease.releaseLease();
    await manager.completeDeferredRetirement("heartbeat-run-1", firstLease.runtime);

    expect(firstLease.runtime.dispose).toHaveBeenCalledTimes(1);
    expect(second.dispose).not.toHaveBeenCalled();
    expect(manager.listSessionIds()).toEqual(["heartbeat-run-2"]);
  });

  it("reuses the runtime when the same session id is acquired again", async () => {
    const manager = createManager();
    const first = await manager.getOrCreate(rolloverParams("heartbeat-run-1"));
    const again = await manager.getOrCreate(rolloverParams("heartbeat-run-1"));

    expect(again).toBe(first);
    expect(first.dispose).not.toHaveBeenCalled();
  });
});
