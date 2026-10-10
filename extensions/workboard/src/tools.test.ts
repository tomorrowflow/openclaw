// Workboard tests cover tools plugin behavior.
import { fileURLToPath } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { isToolResultError } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  resolveAllowedModelRef,
  resolveDefaultModelForAgent,
} from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import plugin from "../index.js";
import { NODE_TARGET } from "./node-ticket.test-support.js";
import { WorkboardStore } from "./store.js";
import { startEmptySessionsBoardService } from "./test/sessions-board.js";
import {
  createWorkboardSqliteTestHarness,
  createWorkboardSqliteTestStore,
} from "./test/sqlite-store.js";
import { createWorkboardSessionsBoardTools } from "./tools-sessions-board.js";
import { createWorkboardTools } from "./tools.js";
import { guardWorkboardToolsForWorkspaceAccess } from "./workspace-access.js";

function readPayload(result: unknown): Record<string, unknown> {
  return (result as { details?: Record<string, unknown> }).details ?? {};
}

describe("workboard tools", () => {
  it("passes live invocation authority through the default-on Sessions board factory", async () => {
    const store = createWorkboardSqliteTestStore();
    await startEmptySessionsBoardService(store);
    const board = await store.upsertBoard({ id: "sessions", kind: "sessions" });
    using openStore = vi.spyOn(WorkboardStore, "openSqlite");
    openStore.mockReturnValue(store);
    const registerTool = vi.fn<OpenClawPluginApi["registerTool"]>();
    plugin.register(
      createTestPluginApi({
        runtimeSource: fileURLToPath(new URL("../index.ts", import.meta.url)),
        registerTool,
      }),
    );
    const [factory, options] = expectDefined(
      registerTool.mock.calls.find(([, registration]) =>
        registration?.names?.includes("workboard_sessions_board_update"),
      ),
      "Sessions board factory",
    );
    expect(options?.optional).not.toBe(true);
    const context = {
      assertInvocationCurrent() {
        throw new Error("Caller authority is no longer active.");
      },
    };
    const tools =
      typeof factory === "function"
        ? factory(context)
        : "create" in factory
          ? factory.create(context)
          : undefined;
    if (!Array.isArray(tools)) {
      throw new Error("Expected Sessions board tools from the registered factory.");
    }
    for (const [name, input] of [
      ["update", { scope: { includeArchived: true } }],
      ["move", { sessionKey: "agent:main:one", columnId: "working" }],
    ] as const) {
      const tool = expectDefined(
        tools.find((entry) => entry.name === `workboard_sessions_board_${name}`),
        name,
      );
      await expect(tool.execute(`revoked-${name}`, input)).rejects.toThrow(
        "Caller authority is no longer active.",
      );
    }
    expect(factory).toMatchObject({ contextVersion: 2 });
    expect(await store.getSessionsBoard("sessions")).toEqual(board);
    expect(await store.listSessionPlacements("sessions")).toEqual([]);
  });

  it("defaults Sessions board tools only when one Sessions board exists", async () => {
    vi.useFakeTimers();
    const store = createWorkboardSqliteTestStore();
    const sessionsBoard = await startEmptySessionsBoardService(store);
    try {
      const tools = new Map(
        [
          ...createWorkboardTools({ store }),
          ...createWorkboardSessionsBoardTools({
            store,
            sessionsBoard,
            caller: { assertCurrent() {} },
          }),
        ].map((tool) => [tool.name, tool]),
      );
      const read = expectDefined(tools.get("workboard_sessions_board_read"), "Sessions board read");
      const update = expectDefined(
        tools.get("workboard_sessions_board_update"),
        "Sessions board update",
      );
      const move = expectDefined(tools.get("workboard_sessions_board_move"), "Sessions board move");
      await expect(read.execute("none", {})).rejects.toThrow("No Sessions board exists");
      const create = expectDefined(tools.get("workboard_board_create"), "Board create");
      expect(Value.Check(create.parameters, { id: "sessions", kind: "sessions" })).toBe(true);
      await create.execute("create", { id: "sessions", name: "My sessions", kind: "sessions" });
      expect(readPayload(await read.execute("one", {}))).toMatchObject({
        board: { id: "sessions", kind: "sessions" },
        sessions: [],
      });
      const scope = { includeArchived: true, includeAutomation: true, includeHome: true };
      expect(Value.Check(update.parameters, { scope })).toBe(true);
      for (const field of ["includeAutomation", "includeHome"]) {
        expect(Value.Check(update.parameters, { scope: { [field]: false } })).toBe(true);
        expect(Value.Check(update.parameters, { scope: { [field]: "true" } })).toBe(false);
      }
      await update.execute("update-one", { scope });
      await expect(store.getSessionsBoard("sessions")).resolves.toMatchObject({
        sessions: { scope },
      });
      const columns = [
        {
          id: "stuck",
          label: "Stuck",
          description: "Observer health is stuck, or the run failed.",
          match: [{ health: ["stuck"] }, { run: ["failed"] }],
        },
        { id: "done", label: "Done", description: "Fallback.", fallback: true },
      ];
      expect(Value.Check(update.parameters, { columns })).toBe(true);
      expect(
        Value.Check(update.parameters, {
          columns: [{ ...columns[0], match: [] }, columns[1]],
        }),
      ).toBe(false);
      await update.execute("update-any-of", { columns });
      await expect(store.getSessionsBoard("sessions")).resolves.toMatchObject({
        sessions: { columns, scope },
      });
      await store.upsertBoard({ id: "another", kind: "sessions" });
      for (const [tool, input] of [
        [read, {}],
        [update, { scope: { includeArchived: false } }],
        [move, { sessionKey: "agent:main:example", columnId: "working" }],
      ] as const) {
        await expect(tool.execute("ambiguous", input)).rejects.toThrow(
          "boardId is required when more than one Sessions board exists",
        );
      }
      expect(readPayload(await read.execute("explicit", { boardId: "another" }))).toMatchObject({
        board: { id: "another", kind: "sessions" },
      });
      await create.execute("create-cards", { id: "cards", kind: "cards" });
      await expect(read.execute("cards", { boardId: "cards" })).rejects.toThrow(
        "This board is not a Sessions board.",
      );
      await expect(read.execute("invalid", { boardId: 42 })).rejects.toThrow();
      await expect(store.getSessionsBoard("sessions")).resolves.toMatchObject({
        sessions: { scope },
      });
    } finally {
      await sessionsBoard.stop();
      vi.useRealTimers();
    }
  });

  it("inherits the active tool filesystem boundary for workspace metadata", async () => {
    const store = createWorkboardSqliteTestStore();
    const restrictedContext = {
      agentId: "main",
      workspaceDir: "/workspace",
      fsPolicy: { workspaceOnly: true },
    } as const;
    const restricted = new Map(
      guardWorkboardToolsForWorkspaceAccess(
        createWorkboardTools({ store, context: restrictedContext }),
        restrictedContext,
      ).map((tool) => [tool.name, tool]),
    );

    await expect(
      restricted.get("workboard_create")?.execute("outside", {
        title: "Outside",
        workspace: { kind: "worktree", path: "/outside/repo" },
      }),
    ).rejects.toThrow(/outside the caller/);
    await expect(
      restricted.get("workboard_create")?.execute("inside", {
        title: "Inside",
        workspace: { kind: "worktree", path: "/workspace/repo" },
        workspaceAccess: { unrestricted: true },
      }),
    ).resolves.toBeDefined();

    const unrestrictedContext = {
      agentId: "main",
      workspaceDir: "/workspace",
      fsPolicy: { workspaceOnly: false },
    } as const;
    const unrestricted = new Map(
      guardWorkboardToolsForWorkspaceAccess(
        createWorkboardTools({ store, context: unrestrictedContext }),
        unrestrictedContext,
      ).map((tool) => [tool.name, tool]),
    );
    await expect(
      unrestricted.get("workboard_create")?.execute("unrestricted", {
        title: "Unrestricted",
        workspace: { kind: "worktree", path: "/outside/repo" },
      }),
    ).resolves.toBeDefined();

    expect((await store.list()).find((card) => card.title === "Inside")).toMatchObject({
      metadata: {
        automation: {
          workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: true },
        },
      },
    });
    expect((await store.list()).find((card) => card.title === "Unrestricted")).toMatchObject({
      metadata: { automation: { workspaceAccess: { unrestricted: true } } },
    });

    const sandboxContext = {
      agentId: "main",
      workspaceDir: "/workspace",
      fsPolicy: { workspaceOnly: false },
      sandboxed: true,
    } as const;
    const sandboxed = new Map(
      guardWorkboardToolsForWorkspaceAccess(
        createWorkboardTools({ store, context: sandboxContext }),
        sandboxContext,
      ).map((tool) => [tool.name, tool]),
    );
    await expect(
      sandboxed.get("workboard_create")?.execute("sandbox-outside", {
        title: "Sandbox outside",
        workspace: { kind: "worktree", path: "/outside/repo" },
      }),
    ).rejects.toThrow(/outside the caller/);
  });

  it("preserves read-only sandbox authority while allowing manual card movement", async () => {
    const store = createWorkboardSqliteTestStore();
    const context: NonNullable<Parameters<typeof guardWorkboardToolsForWorkspaceAccess>[1]> = {
      agentId: "main",
      sessionKey: "agent:main:subagent:readonly",
      workspaceDir: "/workspace",
      sandboxed: true,
      config: {
        agents: {
          defaults: { sandbox: { mode: "all", workspaceAccess: "ro" } },
          entries: { main: { workspace: "/workspace" } },
        },
      },
    };
    const tools = new Map(
      guardWorkboardToolsForWorkspaceAccess(createWorkboardTools({ store, context }), context).map(
        (tool) => [tool.name, tool],
      ),
    );

    const created = readPayload(
      await tools.get("workboard_create")?.execute("create-readonly", {
        title: "Read-only card",
      }),
    ).card as { id: string };
    await expect(
      tools.get("workboard_promote")?.execute("move-readonly", { id: created.id, force: true }),
    ).resolves.toBeDefined();
    await expect(store.get(created.id)).resolves.toMatchObject({
      status: "ready",
      metadata: {
        automation: {
          workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: false },
        },
      },
    });
  });

  it("lists, claims, heartbeats, and reads worker context", async () => {
    const { store: workboardStore, stores } = createWorkboardSqliteTestHarness();
    const keyed = stores.cards;
    const tools = createWorkboardTools({
      store: workboardStore,
      context: { agentId: "main", sessionKey: "session-1" },
    });
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    const store = keyed;
    await store.register("card-1", {
      version: 1,
      card: {
        id: "card-1",
        title: "Ship coordination",
        status: "todo",
        priority: "normal",
        labels: [],
        agentId: "main",
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
      },
    });
    await store.register("archived-1", {
      version: 1,
      card: {
        id: "archived-1",
        title: "Closed work",
        status: "done",
        priority: "normal",
        labels: [],
        position: 2000,
        createdAt: 1,
        updatedAt: 1,
        metadata: { archivedAt: 2 },
      },
    });

    const claimed = readPayload(
      await byName.get("workboard_claim")?.execute("call-1", { id: "card-1" }),
    );
    expect(claimed.card).toMatchObject({
      status: "running",
      metadata: { claim: { ownerId: "main", token: "[redacted]" } },
    });
    const token = (claimed.token as string | undefined) ?? "";

    const heartbeat = readPayload(
      await byName
        .get("workboard_heartbeat")
        ?.execute("call-2", { id: "card-1", token, note: "alive" }),
    );
    expect(heartbeat).toMatchObject({
      card: { metadata: { comments: [expect.objectContaining({ body: "alive" })] } },
    });

    const read = readPayload(
      await byName.get("workboard_read")?.execute("call-3", { id: "card-1" }),
    );
    expect(read.workerContext).toContain("Ship coordination");
    expect(read.card).toMatchObject({ metadata: { claim: { token: "[redacted]" } } });

    const released = readPayload(
      await byName
        .get("workboard_release")
        ?.execute("call-4", { id: "card-1", token, status: "review" }),
    );
    expect(released).toMatchObject({ card: { status: "review" } });
    expect((released.card as { metadata?: { claim?: unknown } }).metadata?.claim).toBeUndefined();

    const list = readPayload(await byName.get("workboard_list")?.execute("call-5", {}));
    expect(list.cards).toEqual([expect.objectContaining({ id: "card-1" })]);
    const archivedList = readPayload(
      await byName.get("workboard_list")?.execute("call-6", { includeArchived: true }),
    );
    expect(archivedList.cards).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "archived-1", archivedAt: 2 })]),
    );
  });

  it("keeps blocked-card mutations out of the host tool failure contract", async () => {
    const { store, stores } = createWorkboardSqliteTestHarness();
    const keyed = stores.cards;
    const tools = createWorkboardTools({
      store,
      context: { agentId: "main" },
    });
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const token = "claim-token-1";
    await keyed.register("card-1", {
      version: 1,
      card: {
        id: "card-1",
        title: "Blocked work",
        status: "blocked",
        priority: "normal",
        labels: [],
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
        metadata: { claim: { ownerId: "main", token, claimedAt: 1, lastHeartbeatAt: 1 } },
      },
    });

    const calls = [
      ["workboard_comment", { id: "card-1", token, body: "still waiting on review" }],
      ["workboard_heartbeat", { id: "card-1", token, note: "still blocked" }],
      ["workboard_release", { id: "card-1", token }],
    ] as const;
    const graded: Array<{ tool: string; isError: boolean; card: unknown }> = [];
    for (const [name, params] of calls) {
      const result = await expectDefined(byName.get(name), name).execute(name, params);
      graded.push({
        tool: name,
        isError: isToolResultError(result),
        card: readPayload(result).card,
      });
    }

    const blockedCard = expect.objectContaining({ id: "card-1", status: "blocked" });
    expect(graded).toEqual([
      { tool: "workboard_comment", isError: false, card: blockedCard },
      { tool: "workboard_heartbeat", isError: false, card: blockedCard },
      { tool: "workboard_release", isError: false, card: blockedCard },
    ]);
    expect((await keyed.lookup("card-1"))?.card).toMatchObject({
      status: "blocked",
      metadata: {
        comments: [
          expect.objectContaining({ body: "still waiting on review" }),
          expect.objectContaining({ body: "still blocked" }),
        ],
      },
    });
    expect((await keyed.lookup("card-1"))?.card.metadata?.claim).toBeUndefined();
  });

  it("can share one store across tool instances for claim coordination", async () => {
    const store = createWorkboardSqliteTestStore();
    const mainTools = new Map(
      createWorkboardTools({
        store,
        context: { agentId: "main" },
      }).map((tool) => [tool.name, tool]),
    );
    const otherTools = new Map(
      createWorkboardTools({
        store,
        context: { agentId: "other" },
      }).map((tool) => [tool.name, tool]),
    );
    const card = await store.create({ title: "Single owner" });

    await mainTools.get("workboard_claim")?.execute("call-1", { id: card.id });

    await expect(
      otherTools.get("workboard_claim")?.execute("call-2", { id: card.id }),
    ).rejects.toThrow(/already claimed/);
  });

  it("requires claim scope before creating or linking dependencies against claimed cards", async () => {
    const store = createWorkboardSqliteTestStore();
    const mainTools = new Map(
      createWorkboardTools({
        store,
        context: { agentId: "main" },
      }).map((tool) => [tool.name, tool]),
    );
    const otherTools = new Map(
      createWorkboardTools({
        store,
        context: { agentId: "other" },
      }).map((tool) => [tool.name, tool]),
    );
    const parent = await store.create({ title: "Claimed parent" });
    const claimed = await store.claim(parent.id, { ownerId: "main", token: "parent-token" });

    await expect(
      otherTools.get("workboard_create")?.execute("call-1", {
        title: "Blocked child",
        parents: [parent.id],
      }),
    ).rejects.toThrow(/claimed by main/);
    await expect(
      otherTools.get("workboard_create")?.execute("call-1b", {
        title: "Blocked child",
        parents: parent.id,
      }),
    ).rejects.toThrow(/claimed by main/);
    expect(await store.list()).toHaveLength(1);

    await expect(
      otherTools.get("workboard_create")?.execute("call-2b", {
        title: "Wrong token child",
        parents: [parent.id],
        token: "test-token-placeholder",
      }),
    ).rejects.toThrow(/claimed by main/);
    await otherTools.get("workboard_create")?.execute("call-2", {
      title: "Scoped child",
      parents: [parent.id],
      token: claimed.token,
    });
    const child = await store.create({ title: "Claimed child" });
    await store.claim(child.id, { ownerId: "child-worker", token: "child-token" });
    await expect(
      otherTools.get("workboard_link")?.execute("call-3", {
        parentId: parent.id,
        childId: child.id,
      }),
    ).rejects.toThrow(/claimed by main/);

    const linked = readPayload(
      await otherTools.get("workboard_link")?.execute("call-4", {
        parentId: parent.id,
        childId: (await store.create({ title: "Idle child" })).id,
        token: claimed.token,
      }),
    );
    expect(linked.card).toMatchObject({ status: "todo" });

    await expect(
      mainTools.get("workboard_link")?.execute("call-5", {
        parentId: parent.id,
        childId: child.id,
        token: "child-token",
      }),
    ).rejects.toThrow(/active child/);
  });

  it("creates dependent cards and completes claimed work through tools", async () => {
    const store = createWorkboardSqliteTestStore();
    const tools = new Map(
      createWorkboardTools({
        store,
        context: { agentId: "main" },
      }).map((tool) => [tool.name, tool]),
    );

    const parentPayload = readPayload(
      await tools.get("workboard_create")?.execute("call-1", {
        title: "Parent",
        status: "running",
      }),
    );
    const parent = parentPayload.card as { id: string };
    const childPayload = readPayload(
      await tools.get("workboard_create")?.execute("call-2", {
        title: "Child",
        parents: [parent.id],
        tenant: "qa",
        skills: ["testing"],
      }),
    );
    const child = childPayload.card as { id: string; status: string };
    expect(child.status).toBe("todo");

    await expect(
      tools.get("workboard_complete")?.execute("call-unclaimed-complete", {
        id: parent.id,
        summary: "Too early.",
      }),
    ).rejects.toThrow(/claimed/);
    await expect(
      tools.get("workboard_block")?.execute("call-unclaimed-block", {
        id: child.id,
        reason: "Too early.",
      }),
    ).rejects.toThrow(/claimed/);
    await expect(
      tools.get("workboard_protocol_violation")?.execute("call-unclaimed-violation", {
        id: child.id,
        detail: "Too early.",
      }),
    ).rejects.toThrow(/claimed/);

    const claimed = readPayload(
      await tools.get("workboard_claim")?.execute("call-3", { id: parent.id }),
    );
    const token = claimed.token as string;
    const pendingProof = readPayload(
      await tools.get("workboard_proof")?.execute("call-proof", {
        id: parent.id,
        token,
        status: "passed",
        command: "pnpm test extensions/workboard",
      }),
    );
    expect(pendingProof.proofId).toEqual(expect.any(String));
    const completed = readPayload(
      await tools.get("workboard_complete")?.execute("call-4", {
        id: parent.id,
        token,
        summary: "Done.",
        createdCardIds: [child.id],
        proofId: pendingProof.proofId,
      }),
    );
    expect(completed.card).toMatchObject({
      status: "done",
      metadata: { proof: [{ id: pendingProof.proofId, status: "passed" }] },
    });

    const dispatch = readPayload(await tools.get("workboard_dispatch")?.execute("call-5", {}));
    expect(dispatch.promoted).toEqual([expect.objectContaining({ id: child.id, status: "ready" })]);
  });

  it("redacts claim tokens from dispatch tool results", async () => {
    const store = createWorkboardSqliteTestStore();
    const tools = new Map(
      createWorkboardTools({
        store,
        context: { agentId: "main" },
      }).map((tool) => [tool.name, tool]),
    );
    const card = await store.create({
      title: "Scheduled",
      status: "scheduled",
      scheduledAt: 1,
    });
    await store.update(card.id, {
      metadata: {
        ...card.metadata,
        claim: {
          ownerId: "main",
          token: "secret-token",
          claimedAt: 1,
          lastHeartbeatAt: 1,
          expiresAt: Date.now() + 60_000,
        },
      },
    });

    const dispatch = readPayload(await tools.get("workboard_dispatch")?.execute("call-1", {}));

    const promoted = dispatch.promoted as Array<{
      metadata?: { claim?: { token?: string } };
    }>;
    expect(promoted).toEqual([expect.objectContaining({ id: card.id })]);
    expect(promoted[0]?.metadata?.claim?.token).toBe("[redacted]");
  });

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
  });

  it("refuses a board node target whose model the assignee's modelPolicy does not allow", async () => {
    const store = createWorkboardSqliteTestStore();
    using openStore = vi.spyOn(WorkboardStore, "openSqlite");
    openStore.mockReturnValue(store);
    let config: OpenClawConfig = {
      agents: {
        defaults: { model: { primary: NODE_TARGET.model } },
        entries: {
          main: {},
          dev: { modelPolicy: { allow: [NODE_TARGET.model] } },
          ops: { modelPolicy: { allow: ["openai/gpt-5.5"] } },
        },
      },
    };
    plugin.register(
      createTestPluginApi({
        runtimeSource: fileURLToPath(new URL("../index.ts", import.meta.url)),
        runtime: {
          config: { current: () => config },
          modelConfig: { resolveAllowedModelRef, resolveDefaultModelForAgent },
        } as unknown as OpenClawPluginApi["runtime"],
      }),
    );

    await store.upsertBoard({
      id: "app",
      orchestration: { defaultAssignee: "dev", defaultTarget: NODE_TARGET },
    });
    await expect(
      store.upsertBoard({
        id: "app",
        orchestration: { defaultTarget: { ...NODE_TARGET, model: "openai/gpt-5.5" } },
      }),
    ).rejects.toThrow(
      "Board app default target model openai/gpt-5.5 is not allowed for agent dev (model not allowed: openai/gpt-5.5). Add it to that agent's modelPolicy.allow or choose an allowed model.",
    );
    await expect(
      store.upsertBoard({
        id: "app",
        orchestration: {
          targetRoutes: [
            { labels: ["class:feature"], target: { ...NODE_TARGET, model: "openai/gpt-5.5" } },
          ],
        },
      }),
    ).rejects.toThrow("Board app route target model openai/gpt-5.5 is not allowed for agent dev");
    // An agent moving the default assignee would strand the operator's target too.
    const boardCreate = expectDefined(
      createWorkboardTools({ store, context: { agentId: "main" } }).find(
        (tool) => tool.name === "workboard_board_create",
      ),
      "board create tool",
    );
    await expect(
      boardCreate.execute("call-board", { id: "app", orchestration: { defaultAssignee: "ops" } }),
    ).rejects.toThrow("is not allowed for agent ops");
    // A board saved before its agent's policy narrowed can still be edited;
    // dispatch meets core's refusal for its target instead.
    config = {
      agents: { entries: { main: {}, dev: { modelPolicy: { allow: ["openai/gpt-5.5"] } } } },
    };
    await store.upsertBoard({ id: "app", name: "App" });
    const board = (await store.listBoards()).boards.find((entry) => entry.id === "app");
    expect(board).toMatchObject({
      name: "App",
      orchestration: { defaultAssignee: "dev", defaultTarget: { model: NODE_TARGET.model } },
    });
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

  it("exposes board lifecycle, decomposition, runs, and notification tools", async () => {
    const store = createWorkboardSqliteTestStore();
    const tools = new Map(
      createWorkboardTools({
        store,
        context: { agentId: "main" },
      }).map((tool) => [tool.name, tool]),
    );

    const boardPayload = readPayload(
      await expectDefined(
        tools.get("workboard_board_create"),
        "workboard board create tool",
      ).execute("call-board", {
        id: "planning",
        name: "Planning",
        automationJobId: "job-categorize-planning",
        orchestration: {
          autoDecompose: true,
          autoDecomposePerDispatch: 2,
          orchestratorProfile: "planner",
        },
      }),
    );
    expect(boardPayload.board).toMatchObject({
      id: "planning",
      name: "Planning",
      automationJobId: "job-categorize-planning",
      orchestration: {
        autoDecompose: true,
        autoDecomposePerDispatch: 2,
        orchestratorProfile: "planner",
      },
    });
    const boardCreate = expectDefined(
      tools.get("workboard_board_create"),
      "workboard board create tool",
    );
    expect(
      Value.Check(boardCreate.parameters, {
        id: "planning",
        automationJobId: "job-categorize-planning",
      }),
    ).toBe(true);
    expect(Value.Check(boardCreate.parameters, { id: "planning", automationJobId: "" })).toBe(
      false,
    );

    const parent = await store.create({
      title: "Rough",
      status: "triage",
      boardId: "planning",
      idempotencyKey: "planning:rough",
    });
    const specified = readPayload(
      await tools.get("workboard_specify")?.execute("call-specify", {
        id: parent.id,
        title: "Specified",
        summary: "Ready to split.",
      }),
    );
    expect(specified.card).toMatchObject({ title: "Specified", status: "todo" });

    const decomposed = readPayload(
      await tools.get("workboard_decompose")?.execute("call-decompose", {
        id: parent.id,
        summary: "Split.",
        children: [{ title: "Child A" }, { title: "Child B" }],
      }),
    );
    expect(decomposed.parent).toMatchObject({ status: "done" });
    expect(decomposed.children).toEqual([
      expect.objectContaining({ title: "Child A" }),
      expect.objectContaining({ title: "Child B" }),
    ]);

    const runs = readPayload(
      await tools.get("workboard_runs")?.execute("call-runs", { id: parent.id }),
    );
    expect(runs.attempts).toEqual([]);

    const subscription = readPayload(
      await tools.get("workboard_notify_subscribe")?.execute("call-subscribe", {
        boardId: "planning",
        cardId: parent.id,
        target: "session:operator",
        eventKinds: ["completed"],
      }),
    );
    expect(subscription.subscription).toMatchObject({
      boardId: "planning",
      cardId: parent.id,
      target: "session:operator",
      eventKinds: ["completed"],
    });

    const list = readPayload(
      await tools.get("workboard_notify_list")?.execute("call-notify-list", {
        boardId: "planning",
      }),
    );
    expect(list.subscriptions).toEqual([
      expect.objectContaining({ cardId: parent.id, target: "session:operator" }),
    ]);

    const events = readPayload(
      await tools.get("workboard_notify_advance")?.execute("call-notify-events", {
        subscriptionId: (subscription.subscription as { id: string }).id,
      }),
    );
    expect(events.events).toEqual([expect.objectContaining({ kind: "completed" })]);

    const attached = readPayload(
      await tools.get("workboard_attachment_add")?.execute("call-attach", {
        id: parent.id,
        fileName: "result.txt",
        contentBase64: Buffer.from("done").toString("base64"),
      }),
    );
    expect(attached.card).toMatchObject({
      metadata: { attachments: [expect.objectContaining({ fileName: "result.txt" })] },
    });
    const attachments = (attached.card as { metadata: { attachments: Array<{ id: string }> } })
      .metadata.attachments;
    const attachmentId = expectDefined(attachments[0], "workboard attachment").id;
    const attachment = readPayload(
      await tools.get("workboard_attachment_read")?.execute("call-attachment-read", {
        id: attachmentId,
      }),
    );
    expect(Buffer.from(attachment.contentBase64 as string, "base64").toString("utf8")).toBe("done");
  });

  it("moves cards with agent claim scope", async () => {
    const store = createWorkboardSqliteTestStore();
    const tools = new Map(
      createWorkboardTools({ store, context: { agentId: "agent-b" } }).map((tool) => [
        tool.name,
        tool,
      ]),
    );
    const card = await store.create({ title: "Move tool card", status: "todo" });

    const unclaimed = readPayload(
      await tools.get("workboard_move")?.execute("move-unclaimed", {
        id: card.id,
        status: "ready",
      }),
    );
    expect(unclaimed.card).toMatchObject({ status: "ready" });

    await store.claim(card.id, { ownerId: "agent-a", token: "test-auth-token" });
    await expect(
      tools.get("workboard_move")?.execute("move-denied", {
        id: card.id,
        status: "review",
      }),
    ).rejects.toThrow("card is claimed by agent-a");

    const claimed = readPayload(
      await tools.get("workboard_move")?.execute("move-claimed", {
        id: card.id,
        status: "review",
        token: "test-auth-token",
      }),
    );
    expect(claimed.card).toMatchObject({ status: "review" });
  });
});
