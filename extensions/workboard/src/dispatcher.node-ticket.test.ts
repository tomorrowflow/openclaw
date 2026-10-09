// Workboard tests cover dispatching cards to paired-node Claude Code sessions.
import { describe, expect, it, vi } from "vitest";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import {
  BASE_COMMIT,
  createNodeCard,
  createNodeGateway,
  NODE_TARGET as TARGET,
} from "./node-ticket.test-support.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";
import { createWorkboardTools } from "./tools.js";
import { guardWorkboardToolsForWorkspaceAccess } from "./workspace-access.js";

describe("dispatchAndStartWorkboardCards node-claude target", () => {
  it("creates the node worktree and starts a Claude session in it", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await createNodeCard(store);
    const nodeTickets = createNodeGateway();
    const run = vi.fn();

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      nodeTickets,
      options: { now: 10, maxStarts: 1 },
    });

    expect(result.startFailures).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    const worktreePath = `${TARGET.worktreesRoot}/wb-${card.id}`;
    const nodeGit = (...args: string[]) => [
      "node.invoke",
      expect.objectContaining({
        nodeId: "mac-factory",
        command: "system.run",
        params: expect.objectContaining({ command: ["git", "-C", TARGET.repoPath, ...args] }),
      }),
    ];
    expect(nodeTickets.respond.mock.calls.map(([method, params]) => [method, params])).toEqual([
      nodeGit("fetch", "--quiet", "origin"),
      nodeGit("rev-parse", "--verify", "--quiet", "main^{commit}"),
      nodeGit("worktree", "add", "-b", `factory/${card.id}`, worktreePath, BASE_COMMIT),
      [
        "node.invoke",
        expect.objectContaining({
          params: expect.objectContaining({
            command: ["git", "-C", worktreePath, "rev-parse", "HEAD"],
          }),
        }),
      ],
      [
        "sessions.create",
        expect.objectContaining({
          key: result.started[0]?.sessionKey,
          agentId: "dev",
          execNode: "mac-factory",
          cwd: worktreePath,
          model: TARGET.model,
          label: `Workboard ${card.id.slice(0, 8)}: Fix the parser`,
          message: expect.stringContaining("```workboard-report"),
        }),
      ],
    ]);
    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "running",
      runId: "run-node",
      execution: { engine: "anthropic", model: "anthropic/claude-sonnet-5-5", runId: "run-node" },
      metadata: {
        automation: {
          target: {
            worktree: { path: worktreePath, branch: `factory/${card.id}`, baseCommit: BASE_COMMIT },
          },
        },
      },
    });
  });

  it("refuses restricted dispatch before claiming or touching the node", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await createNodeCard(store);
    const nodeTickets = createNodeGateway();

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run: vi.fn() },
      nodeTickets,
      options: {
        now: 10,
        maxStarts: 1,
        workspaceAccess: { unrestricted: false, roots: ["/tmp"], writable: true },
      },
    });

    expect(result.startFailures).toEqual([
      expect.objectContaining({
        cardId: card.id,
        error: "node-claude targets require unrestricted Workboard dispatch",
      }),
    ]);
    expect(nodeTickets.respond).not.toHaveBeenCalled();
    const stored = await store.get(card.id);
    expect(stored?.status).toBe("ready");
    expect(stored?.metadata?.claim).toBeUndefined();
  });

  it("starts a project board ticket a sandboxed agent created, owned by the board's assignee", async () => {
    const store = createWorkboardSqliteTestStore();
    await store.upsertBoard({
      id: "app",
      orchestration: { defaultTarget: TARGET, defaultAssignee: "dev" },
    });
    const context = {
      agentId: "dev",
      workspaceDir: "/workspace",
      fsPolicy: { workspaceOnly: true },
    } as const;
    const create = guardWorkboardToolsForWorkspaceAccess(
      createWorkboardTools({ store, context }),
      context,
    ).find((tool) => tool.name === "workboard_create");
    await create?.execute("call-create", {
      title: "Fix the parser",
      boardId: "app",
      status: "ready",
    });
    const nodeTickets = createNodeGateway();

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run: vi.fn() },
      nodeTickets,
      options: { now: Date.now(), maxStarts: 1 },
    });

    expect(result.startFailures).toEqual([]);
    expect(nodeTickets.respond).toHaveBeenCalledWith(
      "sessions.create",
      expect.objectContaining({ agentId: "dev", execNode: "mac-factory" }),
    );
  });

  it("runs node tickets up to the pool size regardless of owner, and review frees a slot", async () => {
    const store = createWorkboardSqliteTestStore();
    store.nodeTicketConcurrency = 2;
    const cards = [
      await createNodeCard(store),
      await createNodeCard(store),
      await createNodeCard(store),
    ];
    const nodeTickets = createNodeGateway();
    const dispatch = async (cardId?: string) =>
      await dispatchAndStartWorkboardCards({
        store,
        subagent: { run: vi.fn() },
        nodeTickets,
        options: { now: Date.now(), maxStarts: 3, ...(cardId ? { cardId } : {}) },
      });

    const first = await dispatch();
    expect(first.started.map((run) => run.cardId)).toEqual([cards[0]?.id, cards[1]?.id]);
    expect(first.startFailures).toEqual([]);
    const full = await dispatch(cards[2]?.id);
    expect(full.startFailures).toEqual([
      expect.objectContaining({
        cardId: cards[2]?.id,
        error:
          "All 2 node ticket slots are in use; a slot frees when a running node ticket reaches review.",
      }),
    ]);

    // An un-accepted ticket in review keeps its claim but no longer holds a node slot.
    const reviewed = await store.get(cards[0]?.id ?? "");
    const claim = reviewed?.metadata?.claim;
    await store.move(reviewed?.id ?? "", "review", undefined, {
      ownerId: claim?.ownerId ?? "",
      token: claim?.token ?? "",
    });
    const next = await dispatch(cards[2]?.id);
    expect(next.startFailures).toEqual([]);
    expect(next.started.map((run) => run.cardId)).toEqual([cards[2]?.id]);
  });

  it("blocks the card with the node's error when the worktree cannot be created", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await createNodeCard(store);
    const nodeTickets = createNodeGateway({ failGit: "worktree" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run: vi.fn() },
      nodeTickets,
      options: { now: 10, maxStarts: 1 },
    });

    expect(result.startFailures[0]?.error).toContain("fatal: branch exists");
    expect(nodeTickets.respond.mock.calls.map(([method]) => method)).not.toContain(
      "sessions.create",
    );
    const stored = await store.get(card.id);
    expect(stored?.status).toBe("blocked");
    expect(stored?.metadata?.claim).toBeUndefined();
  });

  it("reuses the worktree a failed launch left on the card's branch", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await createNodeCard(store);
    const nodeTickets = createNodeGateway({
      failGit: "worktree",
      existingBranch: `factory/${card.id}`,
    });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run: vi.fn() },
      nodeTickets,
      options: { now: 10, maxStarts: 1 },
    });

    expect(result.startFailures).toEqual([]);
    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "running",
      metadata: {
        automation: {
          target: { worktree: { branch: `factory/${card.id}`, baseCommit: BASE_COMMIT } },
        },
      },
    });
  });
});
