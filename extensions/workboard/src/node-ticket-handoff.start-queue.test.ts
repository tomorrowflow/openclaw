// Workboard tests cover queued node-ticket starts draining as parents finish and route slots free up.
import { describe, expect, it, vi } from "vitest";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import { createNodeTicketHandoffs } from "./node-ticket-handoff.js";
import { createNodeGateway, NODE_TARGET } from "./node-ticket.test-support.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

describe("node ticket start queue", () => {
  const LINUX = { ...NODE_TARGET, nodeId: "linux-factory" };

  /** A board whose iOS and server routes each run one ticket at a time, both running one. */
  async function fullRoutes() {
    const store = createWorkboardSqliteTestStore();
    store.nodeTicketConcurrency = 4;
    await store.upsertBoard({
      id: "app",
      orchestration: {
        defaultAssignee: "dev",
        targetRoutes: [
          { labels: ["class:ios-ui"], target: NODE_TARGET, maxConcurrent: 1 },
          { labels: ["class:server-fix"], target: LINUX, maxConcurrent: 1 },
        ],
      },
    });
    const gateway = createNodeGateway();
    const start = async (cardId: string, queue?: "request" | "drain") =>
      await dispatchAndStartWorkboardCards({
        store,
        subagent: { run: vi.fn() },
        nodeTickets: gateway,
        options: { cardId, maxStarts: 1, ...(queue ? { queue } : {}) },
      });
    const handoffs = createNodeTicketHandoffs({
      store,
      runtime: gateway,
      github: { token: () => undefined },
      start,
    });
    const create = async (title: string, label: string) =>
      await store.create({ title, boardId: "app", status: "todo", labels: [label] });
    const runningIos = await create("Fix the header", "class:ios-ui");
    const runningServer = await create("Fix the upload", "class:server-fix");
    for (const card of [runningIos, runningServer]) {
      expect((await start(card.id)).started).toHaveLength(1);
    }
    const toReview = async (cardId: string) => {
      const claim = (await store.get(cardId))?.metadata?.claim;
      await store.move(cardId, "review", undefined, {
        ownerId: claim?.ownerId ?? "",
        token: claim?.token ?? "",
      });
    };
    return { store, gateway, start, handoffs, create, runningIos, runningServer, toReview };
  }

  it("starts the oldest queued request first when its route frees a slot", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    try {
      const { store, start, handoffs, create, runningIos, toReview } = await fullRoutes();
      const older = await create("Fix the wake word", "class:ios-ui");
      const newer = await create("Fix the badge", "class:ios-ui");
      for (const card of [older, newer]) {
        vi.advanceTimersByTime(1000);
        expect((await start(card.id, "request")).queued).toBeDefined();
      }
      const warn = vi.fn();
      await handoffs.resume(warn);
      expect((await store.get(older.id))?.status).toBe("todo");

      await toReview(runningIos.id);
      await handoffs.resume(warn);

      expect(warn).not.toHaveBeenCalled();
      const started = await store.get(older.id);
      expect(started?.status).toBe("running");
      expect(started?.metadata?.automation?.startRequest).toBeUndefined();
      const waiting = await store.get(newer.id);
      expect(waiting?.status).toBe("todo");
      expect(waiting?.metadata?.automation?.startRequest).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a slot that frees mid-pass for the oldest request, not a later card the pass reaches", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    try {
      const { store, gateway, start, create, runningIos, toReview } = await fullRoutes();
      const older = await create("Fix the wake word", "class:ios-ui");
      const newer = await create("Fix the badge", "class:ios-ui");
      for (const card of [older, newer]) {
        vi.advanceTimersByTime(1000);
        expect((await start(card.id, "request")).queued).toBeDefined();
      }
      // The running ticket reaches review while the pass walks the queue: after
      // the older request found the route full, before the newer one's turn.
      let freed = false;
      const handoffs = createNodeTicketHandoffs({
        store,
        runtime: gateway,
        github: { token: () => undefined },
        start: async (cardId, queue) => {
          const result = await start(cardId, queue);
          if (!freed) {
            freed = true;
            await toReview(runningIos.id);
          }
          return result;
        },
      });
      const warn = vi.fn();

      await handoffs.resume(warn);
      expect((await store.get(newer.id))?.status).toBe("todo");

      // The pass the review triggers starts the older request.
      await handoffs.resume(warn);
      expect(warn).not.toHaveBeenCalled();
      expect((await store.get(older.id))?.status).toBe("running");
      expect((await store.get(newer.id))?.status).toBe("todo");
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts a queued card on a free route while an older request waits on a full one", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    try {
      const { store, start, handoffs, create, runningServer, toReview } = await fullRoutes();
      const ios = await create("Fix the wake word", "class:ios-ui");
      const server = await create("Fix the retry", "class:server-fix");
      for (const card of [ios, server]) {
        vi.advanceTimersByTime(1000);
        expect((await start(card.id, "request")).queued).toBeDefined();
      }

      await toReview(runningServer.id);
      await handoffs.resume(vi.fn());

      expect((await store.get(server.id))?.status).toBe("running");
      const waiting = await store.get(ios.id);
      expect(waiting?.status).toBe("todo");
      expect(waiting?.metadata?.automation?.startRequest).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts a card queued on its parents once they are done", async () => {
    const { store, start, handoffs, runningServer, toReview } = await fullRoutes();
    await toReview(runningServer.id);
    const parent = await store.create({
      title: "Design the retry",
      boardId: "app",
      status: "todo",
    });
    const child = await store.create({
      title: "Fix the retry",
      boardId: "app",
      status: "todo",
      labels: ["class:server-fix"],
      parents: [parent.id],
    });
    expect((await start(child.id, "request")).queued).toBeDefined();
    await handoffs.resume(vi.fn());
    expect((await store.get(child.id))?.metadata?.automation?.startRequest).toBeDefined();

    await store.move(parent.id, "done", undefined);
    await handoffs.resume(vi.fn());

    const started = await store.get(child.id);
    expect(started?.status).toBe("running");
    expect(started?.metadata?.automation?.startRequest).toBeUndefined();
  });

  it("drops a request when the card moves to backlog and never starts it after it moves back", async () => {
    const { store, start, handoffs, create, runningIos, toReview } = await fullRoutes();
    const card = await create("Fix the wake word", "class:ios-ui");
    expect((await start(card.id, "request")).queued).toBeDefined();

    await store.move(card.id, "backlog", undefined);
    expect((await store.get(card.id))?.metadata?.automation?.startRequest).toBeUndefined();
    await store.move(card.id, "todo", undefined);
    await toReview(runningIos.id);
    await handoffs.resume(vi.fn());

    const stored = await store.get(card.id);
    expect(stored?.status).toBe("todo");
    expect(stored?.metadata?.automation?.startRequest).toBeUndefined();
  });

  it("blocks a queued card whose start fails for another reason than a full slot", async () => {
    const { store, start, handoffs, create, runningIos, toReview } = await fullRoutes();
    const card = await create("Fix the wake word", "class:ios-ui");
    expect((await start(card.id, "request")).queued).toBeDefined();
    await store.update(card.id, { workspace: { kind: "dir", path: "/tmp/elsewhere" } });

    await toReview(runningIos.id);
    await handoffs.resume(vi.fn());

    const blocked = await store.get(card.id);
    expect(blocked?.status).toBe("blocked");
    expect(blocked?.metadata?.automation?.startRequest).toBeUndefined();
    expect(blocked?.metadata?.comments?.at(-1)?.body).toContain(
      "The queued start failed: node-claude targets use a node worktree",
    );
  });

  it("keeps a queued card queued when it changes while the drain starts it", async () => {
    const { store, start, handoffs, create, runningIos, toReview } = await fullRoutes();
    const card = await create("Fix the wake word", "class:ios-ui");
    expect((await start(card.id, "request")).queued).toBeDefined();
    const claim = store.claim.bind(store);
    vi.spyOn(store, "claim").mockImplementationOnce(async (...args) => {
      // An edit lands between the drain's read and its claim.
      await store.update(card.id, { agentId: "reviewer" });
      return await claim(...args);
    });

    await toReview(runningIos.id);
    await handoffs.resume(vi.fn());

    const waiting = await store.get(card.id);
    expect(waiting?.status).toBe("todo");
    expect(waiting?.metadata?.automation?.startRequest).toBeDefined();

    await handoffs.resume(vi.fn());
    expect((await store.get(card.id))?.status).toBe("running");
  });
});
