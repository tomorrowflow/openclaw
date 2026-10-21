import { expectDefined } from "@openclaw/normalization-core";
// Workboard tests cover dispatching cards to paired-node Claude Code sessions.
import { describe, expect, it, vi } from "vitest";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import { nodeTicketTarget } from "./node-ticket.js";
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
      nodeGit("fetch", "--quiet", "--prune", "origin"),
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
          agentRuntime: "claude-cli",
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

  it("starts a card created with a routed label on the route's node", async () => {
    const store = createWorkboardSqliteTestStore();
    await store.upsertBoard({
      id: "app",
      orchestration: {
        defaultTarget: TARGET,
        defaultAssignee: "dev",
        targetRoutes: [
          { labels: ["class:server-fix"], target: { ...TARGET, nodeId: "linux-factory" } },
        ],
      },
    });
    await store.create({
      title: "Fix the upload endpoint",
      boardId: "app",
      status: "ready",
      labels: ["class:server-fix"],
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
      expect.objectContaining({ agentId: "dev", execNode: "linux-factory" }),
    );
  });

  it("briefs a rung b class with the standards reviewer, reading the rung at each launch", async () => {
    const store = createWorkboardSqliteTestStore();
    await store.upsertBoard({
      id: "default",
      orchestration: { classRungs: { docs: { rung: "b" } } },
    });
    const card = await createNodeCard(store, TARGET, ["class:docs"]);
    const nodeTickets = createNodeGateway();
    const dispatch = async () =>
      await dispatchAndStartWorkboardCards({
        store,
        subagent: { run: vi.fn() },
        nodeTickets,
        options: { now: Date.now(), maxStarts: 1 },
      });
    const briefs = () =>
      nodeTickets.respond.mock.calls.flatMap(([method, params]) =>
        method === "sessions.create" ? [String(params?.message)] : [],
      );
    const rung = async () =>
      nodeTicketTarget(expectDefined(await store.get(card.id), "card"))?.worktree?.rung;

    expect((await dispatch()).startFailures).toEqual([]);
    expect(briefs()[0]).toContain(
      "run a reviewer subagent over your changes against the repository's CODING_STANDARDS.md",
    );
    expect(briefs()[0]).toContain(
      "- Change files with your Edit and Write tools, not with shell redirection, `sed -i`, or scripts that rewrite files",
    );
    expect(briefs()[0]).toContain(
      'A review with no findings sends `"items":[]`. For a finding you left, `line` is its line number in the file at your final commit (HEAD): re-check it after the last commit.',
    );
    expect(briefs()[0]).toContain(
      '"review":{"items":[{"path":"…","line":1,"rule":"…","body":"…","fixed":true}],"note":"…"}',
    );
    await expect(rung()).resolves.toBe("b");
    const baseCommit = nodeTicketTarget(expectDefined(await store.get(card.id), "card"))?.worktree
      ?.baseCommit;
    expect(briefs()[0]).toContain(
      `leave the worktree clean (\`git status --porcelain\` prints nothing) and make \`git diff --check ${baseCommit}..HEAD\` pass`,
    );

    // A demotion applies from the next launch: the re-run is briefed and recorded at rung a.
    await store.upsertBoard({ id: "default", orchestration: { classRungs: null } });
    const claim = expectDefined((await store.get(card.id))?.metadata?.claim, "claim");
    await store.block(card.id, { reason: "node restarted" }, claim);
    await store.move(card.id, "ready", undefined);
    expect((await dispatch()).startFailures).toEqual([]);
    expect(briefs()[1]).toBeDefined();
    expect(briefs()[1]).not.toContain("CODING_STANDARDS.md");
    await expect(rung()).resolves.toBeUndefined();
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

  it("holds a capped route to its own slots inside the pool, including cards made before the cap", async () => {
    const store = createWorkboardSqliteTestStore();
    store.nodeTicketConcurrency = 3;
    const linux = { ...TARGET, nodeId: "linux-factory" };
    const routes = [
      { labels: ["class:ios-ui", "class:ios-device"], target: TARGET },
      { labels: ["class:server-fix"], target: linux },
    ];
    await store.upsertBoard({
      id: "app",
      orchestration: { defaultTarget: TARGET, defaultAssignee: "dev", targetRoutes: routes },
    });
    const create = async (title: string, label: string) =>
      await store.create({ title, boardId: "app", status: "ready", labels: [label] });
    const firstIos = await create("Fix the header", "class:ios-ui");
    const secondIos = await create("Fix the wake word", "class:ios-device");
    const server = await create("Fix the upload", "class:server-fix");
    await store.upsertBoard({
      id: "app",
      orchestration: { targetRoutes: [{ ...routes[0], maxConcurrent: 1 }, routes[1]] },
    });
    const nodeTickets = createNodeGateway();
    const dispatch = async (cardId?: string) =>
      await dispatchAndStartWorkboardCards({
        store,
        subagent: { run: vi.fn() },
        nodeTickets,
        options: { now: Date.now(), maxStarts: 3, ...(cardId ? { cardId } : {}) },
      });

    const first = await dispatch();
    expect(first.startFailures).toEqual([]);
    expect(first.started.map((run) => run.cardId).toSorted()).toEqual(
      [firstIos.id, server.id].toSorted(),
    );
    const busy =
      "The class:ios-ui, class:ios-device route's 1 node ticket slot is in use; it frees when a running ticket on that route reaches review.";
    await expect(dispatch(secondIos.id)).resolves.toMatchObject({
      startFailures: [expect.objectContaining({ cardId: secondIos.id, error: busy })],
    });
    // The claim enforces the cap itself, not only the dispatcher's selection.
    await expect(store.claim(secondIos.id, { ownerId: "dev" })).rejects.toThrow(busy);
    await expect(store.get(secondIos.id)).resolves.toMatchObject({ status: "ready" });
    // A full pool is named as the pool, even when the route is full too.
    store.nodeTicketConcurrency = 2;
    await expect(store.claim(secondIos.id, { ownerId: "dev" })).rejects.toThrow(
      "All 2 node ticket slots are in use",
    );
  });

  it("starts a pooled route's tickets on its first node with a free slot, and keeps a started ticket on its node", async () => {
    const store = createWorkboardSqliteTestStore();
    store.nodeTicketConcurrency = 4;
    const big = { ...TARGET, nodeId: "linux-3090" };
    const small = { ...TARGET, nodeId: "linux-790" };
    await store.upsertBoard({
      id: "app",
      orchestration: {
        defaultAssignee: "dev",
        targetRoutes: [
          {
            labels: ["class:server-fix"],
            target: big,
            alternateTargets: [small],
            maxConcurrent: 1,
          },
        ],
      },
    });
    const create = async (title: string) =>
      await store.create({ title, boardId: "app", status: "ready", labels: ["class:server-fix"] });
    const first = await create("Fix the upload");
    const second = await create("Fix the retry");
    const third = await create("Fix the schema");
    const nodeTickets = createNodeGateway();
    const dispatch = async (cardId?: string) =>
      await dispatchAndStartWorkboardCards({
        store,
        subagent: { run: vi.fn() },
        nodeTickets,
        options: { now: Date.now(), maxStarts: 3, ...(cardId ? { cardId } : {}) },
      });
    const nodeOf = async (id: string) =>
      (await store.get(id))?.metadata?.automation?.target?.nodeId;

    const started = await dispatch();
    expect(started.startFailures).toEqual([]);
    expect(started.started.map((run) => run.cardId)).toEqual([first.id, second.id]);
    await expect(nodeOf(first.id)).resolves.toBe("linux-3090");
    await expect(nodeOf(second.id)).resolves.toBe("linux-790");
    expect(
      nodeTickets.respond.mock.calls
        .filter(([method]) => method === "sessions.create")
        .map(([, params]) => params?.execNode),
    ).toEqual(["linux-3090", "linux-790"]);

    const busy =
      "Each of the class:server-fix route's 2 nodes has its 1 node ticket slot in use; one frees when a running ticket on that route reaches review.";
    await expect(dispatch(third.id)).resolves.toMatchObject({
      startFailures: [expect.objectContaining({ cardId: third.id, error: busy })],
    });
    await expect(store.claim(third.id, { ownerId: "dev" })).rejects.toThrow(busy);
    await expect(nodeOf(third.id)).resolves.toBe("linux-3090");

    // Both nodes free up; the ticket with a worktree on the 790 stays there.
    for (const id of [first.id, second.id]) {
      const claim = (await store.get(id))?.metadata?.claim;
      await store.releaseClaim(id, {
        ownerId: claim?.ownerId,
        token: claim?.token,
        status: id === first.id ? "review" : "todo",
      });
    }
    await store.claim(second.id, { ownerId: "dev" });
    await expect(store.get(second.id)).resolves.toMatchObject({
      metadata: { automation: { target: { nodeId: "linux-790", worktree: expect.any(Object) } } },
    });
    await store.claim(third.id, { ownerId: "dev" });
    await expect(nodeOf(third.id)).resolves.toBe("linux-3090");
    // A ticket held to its node by its worktree is told which node it waits for.
    await store.move(first.id, "todo", undefined);
    await expect(store.claim(first.id, { ownerId: "dev" })).rejects.toThrow(
      "The class:server-fix route's 1 node ticket slot on node linux-3090, where this ticket's worktree is, is in use; it frees when a running ticket of that route on linux-3090 reaches review.",
    );
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

  it("blocks the card with the Gateway's reason when the session starts no run", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await createNodeCard(store);
    const nodeTickets = createNodeGateway();
    const answer = nodeTickets.respond.getMockImplementation()!;
    nodeTickets.respond.mockImplementation((method, params) =>
      method === "sessions.create"
        ? {
            ok: true,
            key: params?.key,
            runStarted: false,
            runError: { code: "UNAVAILABLE", message: "model auth expired" },
          }
        : answer(method, params),
    );

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run: vi.fn() },
      nodeTickets,
      options: { now: 10, maxStarts: 1 },
    });

    expect(result.startFailures[0]?.error).toContain(
      "node ticket session did not start: model auth expired",
    );
    expect((await store.get(card.id))?.status).toBe("blocked");
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
