import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { describe, expect, it, vi } from "vitest";
import { createWorkboardAutomationNudgeService } from "./automation-nudge.js";
import { createWorkboardFeedService } from "./feed-service.js";
import type { WorkboardCardFeed } from "./feed.js";
import { nudgeContext } from "./lifecycle-sync.test-support.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

type Bindings = PluginRuntime["channel"]["bindings"];
type LoadAdapter = PluginRuntime["channel"]["outbound"]["loadAdapter"];
type SendText = NonNullable<NonNullable<Awaited<ReturnType<LoadAdapter>>>["sendText"]>;

function fakeChannel() {
  let threads = 0;
  const sendText = vi.fn<SendText>(async () => ({ channel: "discord", messageId: "m" }));
  const bindOwned = vi.fn<Bindings["bindOwned"]>(async (params) => ({
    bindingId: "b",
    pluginId: "workboard",
    pluginRoot: "/wb",
    channel: "discord",
    accountId: "default",
    conversationId:
      params.placement === "child" ? `thread-${++threads}` : params.conversation.conversationId,
    boundAt: 0,
  }));
  const unbindOwned = vi.fn<Bindings["unbindOwned"]>(async () => ({ removed: true }));
  const channel: Pick<PluginRuntime["channel"], "outbound" | "bindings"> = {
    outbound: {
      loadAdapter: vi.fn<LoadAdapter>(async () => ({ deliveryMode: "direct", sendText })),
    },
    bindings: { bindOwned, unbindOwned },
  };
  const posts = () =>
    sendText.mock.calls.map(([ctx]) => `${ctx.threadId} ${ctx.identity?.name}: ${ctx.text}`);
  return { channel, sendText, bindOwned, unbindOwned, posts };
}

// The plugin keyed store's entries/register contract over a Map.
function fakeState() {
  const rows = new Map<string, WorkboardCardFeed>();
  return {
    rows,
    entries: async () =>
      [...rows].map(([key, value]) => ({ key, value: structuredClone(value), createdAt: 0 })),
    register: async (key: string, value: WorkboardCardFeed) => {
      rows.set(key, structuredClone(value));
    },
  };
}

describe("workboard board feed", () => {
  it("projects one card into one thread and takes the operator's replies as comments", async () => {
    const store = createWorkboardSqliteTestStore();
    await store.upsertBoard({
      id: "factory",
      automationJobId: "job-chef",
      orchestration: { feed: { channel: "discord", to: "chan-1", operatorId: "op-1" } },
    });
    const card = await store.create({ title: "Fix login", status: "todo", boardId: "factory" });
    await store.create({ title: "Elsewhere", status: "todo" });
    const ref = card.id.slice(0, 8);
    const fake = fakeChannel();
    const enqueueRun = vi.fn().mockResolvedValue({ ok: true, ran: true });
    const nudge = createWorkboardAutomationNudgeService({ store });
    await nudge.start(nudgeContext(enqueueRun));
    const state = fakeState();
    const startFeed = () =>
      createWorkboardFeedService({
        store,
        openState: () => state,
        channel: fake.channel,
        config: () => ({}),
        onOperatorComment: nudge.nudge,
      });
    let feed = startFeed();
    try {
      await feed.sync();
      await feed.sync();
      expect(fake.bindOwned.mock.calls.map(([p]) => [p.placement, p.threadName])).toEqual([
        ["child", `[${ref}] Fix login`],
      ]);
      expect(fake.posts()).toEqual([`thread-1 Workboard: ${ref} Fix login: todo.`]);

      await store.update(card.id, { status: "running", agentId: "dev" });
      await store.addComment(card.id, { body: "Halfway there." }, undefined, "agent:dev");
      await feed.sync();
      expect(fake.posts().slice(1)).toEqual([
        `thread-1 dev: Started ${ref}.`,
        "thread-1 dev: Halfway there.",
      ]);

      const pluginBinding = {
        ...(await fake.bindOwned.mock.results[0]?.value),
        data: { cardId: card.id, boardId: "factory" },
      };
      const reply = (senderId: string, content: string) =>
        feed.claim(
          { content, senderId, channel: "discord", isGroup: true },
          { channelId: "discord", pluginBinding },
        );
      await expect(reply("op-1", "Go with option B.")).resolves.toEqual({ handled: true });
      await expect(reply("someone", "Me too")).resolves.toEqual({ handled: true });
      const claimed = await store.get(card.id);
      expect(claimed?.metadata?.comments?.map((c) => [c.source, c.body])).toEqual([
        ["agent:dev", "Halfway there."],
        ["operator", "Go with option B."],
      ]);
      expect(enqueueRun.mock.calls).toEqual([["job-chef", "if-enabled"]]);
      // A Gateway restart reloads the snapshot and the claim: no repost, no echo.
      await feed.stop();
      feed = startFeed();
      await feed.sync();
      expect(fake.sendText).toHaveBeenCalledTimes(3);

      fake.sendText.mockRejectedValueOnce(new Error("rate limited"));
      fake.sendText.mockRejectedValueOnce(new Error("rate limited"));
      await store.update(card.id, { labels: ["needs:user"] });
      await feed.sync();
      await feed.sync();
      expect(fake.sendText).toHaveBeenCalledTimes(5);
      expect(fake.posts()[4]).toBe(`thread-1 Workboard: <@op-1> ${ref} needs you.`);
      expect(feed.health()).toMatchObject({ posts: 0, failures: 1, lastError: "rate limited" });

      await store.update(card.id, { status: "done" });
      await feed.sync();
      expect(fake.posts().at(-1)).toBe(`thread-1 Workboard: ${ref} is done.`);
      expect(fake.unbindOwned).toHaveBeenCalledOnce();
    } finally {
      nudge.stop();
      await feed.stop();
    }
  });
});
