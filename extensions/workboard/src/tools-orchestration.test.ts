import { expectDefined } from "@openclaw/normalization-core";
import type { WorkboardHealthResult } from "@openclaw/workboard-contract";
import { describe, expect, it, vi } from "vitest";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";
import { createWorkboardTools } from "./tools.js";
import { readPayload } from "./tools.test-support.js";

describe("workboard_stats tool", () => {
  it("returns the factory health for the calling agent only on request", async () => {
    const store = createWorkboardSqliteTestStore();
    const health: WorkboardHealthResult = {
      generatedAt: 1,
      automations: [{ id: "job-brief", boardIds: [], exists: false }],
      nodes: [],
      accounts: { status: "unknown", reason: "no auth store" },
    };
    const read = vi.fn().mockResolvedValue(health);
    const tools = new Map(
      createWorkboardTools({ store, context: { agentId: "andri" }, health: { read } }).map(
        (tool) => [tool.name, tool],
      ),
    );
    const stats = expectDefined(tools.get("workboard_stats"), "workboard_stats tool");

    expect(readPayload(await stats.execute("stats-plain", {}))).not.toHaveProperty("health");
    expect(read).not.toHaveBeenCalled();

    expect(readPayload(await stats.execute("stats-health", { health: true }))).toMatchObject({
      id: "all",
      health,
    });
    expect(read).toHaveBeenCalledWith({ agentId: "andri" });
  });

  it("returns the overview and merge digest from workboard_stats on request", async () => {
    const store = createWorkboardSqliteTestStore();
    const tools = new Map(createWorkboardTools({ store }).map((tool) => [tool.name, tool]));
    const stats = expectDefined(tools.get("workboard_stats"), "workboard_stats tool");
    await store.create({ title: "Stats card", status: "todo" });

    const plain = readPayload(await stats.execute("stats-plain", {}));
    expect(plain).toMatchObject({ id: "all", total: 1 });
    expect(plain).not.toHaveProperty("overview");
    expect(plain).not.toHaveProperty("mergeDigest");

    const since = Date.now() - 60_000;
    const extended = readPayload(
      await stats.execute("stats-extended", { overview: true, mergeDigest: true, since }),
    );
    expect(extended).toMatchObject({
      id: "all",
      total: 1,
      overview: { boardId: "all", needsYou: [], inFlight: [], shipped: [] },
      mergeDigest: { boardId: "all", since, classes: [] },
    });
  });
});

describe("workboard_class_rung tool", () => {
  it("sets one class and keeps the other classes and board settings", async () => {
    const store = createWorkboardSqliteTestStore();
    await store.upsertBoard({
      id: "default",
      orchestration: {
        defaultAssignee: "dev",
        classRungs: { docs: { rung: "b" }, "ios-logic": { rung: "c", since: 1_000 } },
      },
    });
    const tools = new Map(createWorkboardTools({ store }).map((tool) => [tool.name, tool]));
    const classRung = expectDefined(tools.get("workboard_class_rung"), "workboard_class_rung");

    const restamp = Date.now() - 60_000;
    expect(
      readPayload(
        await classRung.execute("restamp", {
          boardId: "default",
          class: "docs",
          rung: "b",
          since: restamp,
        }),
      ),
    ).toEqual({
      classRungs: { docs: { rung: "b", since: restamp }, "ios-logic": { rung: "c", since: 1_000 } },
    });

    const before = Date.now();
    await classRung.execute("promote", { boardId: "default", class: "server-fix", rung: "b" });
    const orchestration = await store.boardOrchestration("default");
    expect(orchestration?.defaultAssignee).toBe("dev");
    expect(orchestration?.classRungs?.["ios-logic"]).toEqual({ rung: "c", since: 1_000 });
    expect(orchestration?.classRungs?.["server-fix"]?.since).toBeGreaterThanOrEqual(before);

    await expect(
      classRung.execute("missing", { boardId: "nope", class: "docs", rung: "b" }),
    ).rejects.toThrow("does not exist");
  });
});
