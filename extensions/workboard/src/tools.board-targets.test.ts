import { expectDefined } from "@openclaw/normalization-core";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { NODE_TARGET } from "./node-ticket.test-support.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";
import { createWorkboardTools } from "./tools.js";
import { readPayload } from "./tools.test-support.js";

describe("workboard tool board targets", () => {
  it("hands a project board's operator-set node target to cards its agent creates", async () => {
    const store = createWorkboardSqliteTestStore();
    await store.upsertBoard({ id: "app", orchestration: { defaultTarget: NODE_TARGET } });
    const tools = new Map(
      createWorkboardTools({ store, context: { agentId: "dev" } }).map((tool) => [tool.name, tool]),
    );
    const boardCreate = expectDefined(tools.get("workboard_board_create"), "board create tool");
    expect(
      Value.Check(boardCreate.parameters, {
        id: "app",
        orchestration: { defaultTarget: NODE_TARGET },
      }),
    ).toBe(false);
    await boardCreate.execute("call-board", { id: "app", orchestration: { autoDecompose: true } });

    const created = readPayload(
      await expectDefined(tools.get("workboard_create"), "create tool").execute("call-create", {
        title: "Fix the parser",
        boardId: "app",
      }),
    );
    expect(created.card).toMatchObject({ metadata: { automation: { target: NODE_TARGET } } });
    const optedOut = await store.create({
      title: "Plan the batch",
      boardId: "app",
      metadata: { automation: { target: null } },
    });
    expect(optedOut.metadata?.automation?.target).toBeUndefined();
    const elsewhere = await store.create({ title: "Elsewhere" });
    expect(elsewhere.metadata?.automation?.target).toBeUndefined();
  });

  it("routes a new card to the first board target route that shares one of its labels", async () => {
    const store = createWorkboardSqliteTestStore();
    const linux = { ...NODE_TARGET, nodeId: "linux-factory" };
    const spare = { ...NODE_TARGET, nodeId: "spare-factory" };
    await store.upsertBoard({
      id: "app",
      orchestration: {
        defaultTarget: NODE_TARGET,
        targetRoutes: [
          { labels: ["class:server-fix", "class:feature"], target: linux },
          { labels: ["class:docs"], target: spare },
        ],
      },
    });
    const tools = new Map(
      createWorkboardTools({ store, context: { agentId: "dev" } }).map((tool) => [tool.name, tool]),
    );
    const boardCreate = expectDefined(tools.get("workboard_board_create"), "board create tool");
    expect(
      Value.Check(boardCreate.parameters, {
        id: "app",
        orchestration: { targetRoutes: [{ labels: ["x"], target: NODE_TARGET }] },
      }),
    ).toBe(false);
    // An agent editing the board keeps the operator's routes.
    await boardCreate.execute("call-board", { id: "app", orchestration: { autoDecompose: true } });

    const routed = readPayload(
      await expectDefined(tools.get("workboard_create"), "create tool").execute("call-create", {
        title: "Fix the parser",
        boardId: "app",
        labels: ["class:docs", "class:feature"],
      }),
    );
    expect(routed.card).toMatchObject({ metadata: { automation: { target: linux } } });
    const unrouted = await store.create({ title: "Polish", boardId: "app", labels: ["ui"] });
    expect(unrouted.metadata?.automation?.target).toEqual(NODE_TARGET);
    const optedOut = await store.create({
      title: "Plan the batch",
      boardId: "app",
      labels: ["class:feature"],
      metadata: { automation: { target: null } },
    });
    expect(optedOut.metadata?.automation?.target).toBeUndefined();
    // Routing is create-time only; relabeling keeps the inherited target.
    const relabeled = await store.update(unrouted.id, { labels: ["class:docs"] });
    expect(relabeled.metadata?.automation?.target).toEqual(NODE_TARGET);
    await store.upsertBoard({ id: "app", orchestration: { targetRoutes: null } });
    const cleared = await store.create({ title: "Add", boardId: "app", labels: ["class:feature"] });
    expect(cleared.metadata?.automation?.target).toEqual(NODE_TARGET);
  });

  it("refuses board target routes with no labels or a label another route claims", async () => {
    const store = createWorkboardSqliteTestStore();
    await expect(
      store.upsertBoard({
        id: "app",
        orchestration: { targetRoutes: [{ labels: [], target: NODE_TARGET }] },
      }),
    ).rejects.toThrow("target route labels must name at least one label.");
    await expect(
      store.upsertBoard({
        id: "app",
        orchestration: {
          targetRoutes: [
            { labels: ["class:feature"], target: NODE_TARGET },
            { labels: ["class:refactor", "class:feature"], target: NODE_TARGET },
          ],
        },
      }),
    ).rejects.toThrow("target route label class:feature appears in more than one route.");
    await expect(
      store.upsertBoard({
        id: "app",
        orchestration: {
          targetRoutes: [{ labels: ["class:feature"], target: NODE_TARGET, maxConcurrent: 0 }],
        },
      }),
    ).rejects.toThrow("target route maxConcurrent must be an integer from 1 to 16.");
    const alternate = { ...NODE_TARGET, nodeId: "linux-factory" };
    await expect(
      store.upsertBoard({
        id: "app",
        orchestration: {
          targetRoutes: [
            { labels: ["class:feature"], target: NODE_TARGET, alternateTargets: [alternate] },
          ],
        },
      }),
    ).rejects.toThrow("a target route with alternateTargets needs maxConcurrent.");
    await expect(
      store.upsertBoard({
        id: "app",
        orchestration: {
          targetRoutes: [
            {
              labels: ["class:feature"],
              target: NODE_TARGET,
              alternateTargets: [alternate, { ...alternate, repoPath: "/srv/app" }],
              maxConcurrent: 1,
            },
          ],
        },
      }),
    ).rejects.toThrow("target route node linux-factory appears more than once.");
  });

  it("assigns new cards to the board's default assignee unless the creator names one", async () => {
    const store = createWorkboardSqliteTestStore();
    await store.upsertBoard({ id: "app", orchestration: { defaultAssignee: "dev" } });
    const create = expectDefined(
      createWorkboardTools({ store, context: { agentId: "main" } }).find(
        (tool) => tool.name === "workboard_create",
      ),
      "create tool",
    );

    const inherited = readPayload(
      await create.execute("call-inherit", { title: "Fix the parser", boardId: "app" }),
    );
    const named = readPayload(
      await create.execute("call-named", { title: "Review", boardId: "app", agentId: "main" }),
    );

    expect(inherited.card).toMatchObject({ agentId: "dev" });
    expect(named.card).toMatchObject({ agentId: "main" });
    expect((await store.create({ title: "Elsewhere" })).agentId).toBeUndefined();
  });
});
