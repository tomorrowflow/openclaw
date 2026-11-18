import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginService } from "../api.js";
import { createWorkboardAutomationNudgeService } from "./automation-nudge.js";
import { createWorkboardFeedService } from "./feed-service.js";
import type { WorkboardCardFeed } from "./feed.js";
import { nudgeContext } from "./lifecycle-sync.test-support.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

type Bindings = PluginRuntime["channel"]["bindings"];
type LoadAdapter = PluginRuntime["channel"]["outbound"]["loadAdapter"];
type SendText = NonNullable<NonNullable<Awaited<ReturnType<LoadAdapter>>>["sendText"]>;

type ServiceContext = Parameters<OpenClawPluginService["start"]>[0];

function fakeChannel() {
  let threads = 0;
  const keepTyping = vi.fn<PluginRuntime["channel"]["outbound"]["keepTyping"]>(async () => {});
  const sendText = vi.fn<SendText>(async () => ({ channel: "discord", messageId: "m" }));
  const bindOwned = vi.fn<Bindings["bindOwned"]>(async () => ({
    bindingId: "b",
    pluginId: "workboard",
    pluginRoot: "/wb",
    channel: "discord",
    accountId: "default",
    conversationId: `thread-${++threads}`,
    boundAt: 0,
  }));
  const channel: Pick<PluginRuntime["channel"], "outbound" | "bindings"> = {
    outbound: {
      loadAdapter: vi.fn<LoadAdapter>(async () => ({ deliveryMode: "direct", sendText })),
      keepTyping,
    },
    bindings: { bindOwned },
  };
  const posts = () =>
    sendText.mock.calls.map(([ctx]) => `${ctx.threadId} ${ctx.identity?.name}: ${ctx.text}`);
  return { channel, sendText, bindOwned, keepTyping, posts };
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

// Runs the service's scheduled jobs by hand; `runJob` advances the clock by the job's delay.
function fakeScheduler(clock: { at: number }) {
  const jobs = new Map<string, { delayMs: number; run: () => unknown }>();
  type Scheduler = NonNullable<ServiceContext["scheduler"]>;
  const scheduler: Scheduler = {
    version: 1,
    signal: new AbortController().signal,
    now: () => clock.at,
    schedule: (job) => {
      jobs.set(job.id, { delayMs: "delayMs" in job ? job.delayMs : 0, run: job.run });
      return { cancel: () => jobs.delete(job.id), stop: async () => {} };
    },
    scope: () => scheduler,
    beginClose: () => {},
    stop: async () => {},
  };
  const runJob = async (id: string) => {
    const job = jobs.get(id);
    jobs.delete(id);
    clock.at += job?.delayMs ?? 0;
    await job?.run();
  };
  return { jobs, scheduler, runJob };
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
      expect(fake.bindOwned.mock.calls.map(([p]) => p.threadName)).toEqual([`[${ref}] Fix login`]);
      expect(fake.posts()).toEqual([`thread-1 Workboard: ${ref}: todo.`]);

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

      await store.upsertBoard({ id: "factory", orchestration: { feed: null } });
      const off = await reply("op-1", "Still there?");
      expect(off).toMatchObject({
        handled: true,
        reply: { text: expect.stringContaining("Control UI") },
      });
      expect((await store.get(card.id))?.metadata?.comments).toHaveLength(2);
    } finally {
      nudge.stop();
      await feed.stop();
    }
  });

  it("tries a thread that failed to open again after ten minutes, without a card change", async () => {
    const store = createWorkboardSqliteTestStore();
    await store.upsertBoard({
      id: "factory",
      orchestration: { feed: { channel: "discord", to: "chan-1", operatorId: "op-1" } },
    });
    await store.create({ title: "[FAC-1] Fix login", status: "todo", boardId: "factory" });
    const fake = fakeChannel();
    fake.bindOwned.mockRejectedValueOnce(new Error("adapter unavailable"));
    const clock = { at: 1_000 };
    const { jobs, scheduler, runJob } = fakeScheduler(clock);
    const feed = createWorkboardFeedService({
      store,
      openState: () => fakeState(),
      channel: fake.channel,
      config: () => ({}),
      now: () => clock.at,
    });
    await feed.start({ ...nudgeContext(vi.fn()), scheduler });
    try {
      await runJob("workboard-feed");
      expect(feed.health()).toMatchObject({ failures: 1, lastError: "adapter unavailable" });
      expect(jobs.get("workboard-feed-retry")?.delayMs).toBe(10 * 60_000);

      await runJob("workboard-feed-retry");
      expect(fake.bindOwned).toHaveBeenCalledTimes(2);
      expect(fake.posts()).toEqual(["thread-1 Workboard: FAC-1: todo."]);
      expect(jobs.has("workboard-feed-retry")).toBe(false);
    } finally {
      await feed.stop();
    }
  });

  it("has the feed's agent answer the operator's replies in the card's thread", async () => {
    const store = createWorkboardSqliteTestStore();
    await store.upsertBoard({
      id: "glovebox",
      orchestration: {
        feed: { channel: "discord", to: "chan-1", operatorId: "op-1", agentId: "chef" },
      },
    });
    const card = await store.create({
      title: "[GADL-04] Install production",
      status: "todo",
      boardId: "glovebox",
    });
    const fake = fakeChannel();
    const answers = ["Noted: zotac1070 and port 8780.", "Yes, I recorded the backup host too."];
    let duringFirstTurn: (() => Promise<unknown>) | undefined;
    let runs = 0;
    const subagent = {
      run: vi.fn<PluginRuntime["subagent"]["run"]>(async () => {
        await duringFirstTurn?.();
        duringFirstTurn = undefined;
        return { runId: `run-${++runs}` };
      }),
      waitForRun: vi.fn<PluginRuntime["subagent"]["waitForRun"]>(async () => ({ status: "ok" })),
      getSessionMessages: vi.fn<PluginRuntime["subagent"]["getSessionMessages"]>(async () => ({
        messages: [
          { role: "user", content: "..." },
          { role: "assistant", content: [{ type: "text", text: answers.shift() ?? "" }] },
        ],
      })),
      deleteSession: vi.fn<PluginRuntime["subagent"]["deleteSession"]>(async () => {}),
    };
    const clock = { at: 1_000 };
    const { jobs, scheduler, runJob } = fakeScheduler(clock);
    const feed = createWorkboardFeedService({
      store,
      openState: () => fakeState(),
      channel: fake.channel,
      subagent,
      config: () => ({}),
      now: () => clock.at,
    });
    await feed.start({ ...nudgeContext(vi.fn()), scheduler });
    const answerJob = `workboard-feed-answer:${card.id}`;
    const reply = async (content: string) =>
      feed.claim(
        { content, senderId: "op-1", channel: "discord", isGroup: true },
        {
          channelId: "discord",
          pluginBinding: {
            ...(await fake.bindOwned.mock.results[0]?.value),
            data: { cardId: card.id, boardId: "glovebox" },
          },
        },
      );
    try {
      await runJob("workboard-feed");
      await reply("production host is zotac1070");
      await reply("and keep port 8780");
      expect([...jobs.keys()].filter((id) => id === answerJob)).toHaveLength(1);
      // Sent while the first turn runs; its answer lands after this message.
      duringFirstTurn = () => reply("also note the backup host");

      await runJob(answerJob);
      expect(subagent.run).toHaveBeenCalledTimes(2);
      const [first, second] = subagent.run.mock.calls.map(([turn]) => turn);
      expect(first?.sessionKey).toBe(`agent:chef:workboard-thread:${card.id}`);
      expect(first?.message).toContain("operator: production host is zotac1070");
      expect(first?.message).toContain("operator: and keep port 8780");
      expect(second?.message).toContain("operator: also note the backup host");
      expect(second?.message).not.toContain(
        "## The operator's messages to answer\n- operator: production",
      );
      expect(fake.keepTyping).toHaveBeenCalledWith(
        expect.objectContaining({ channel: "discord", to: "chan-1", threadId: "thread-1" }),
      );
      await feed.sync();
      expect(fake.posts().slice(-2)).toEqual([
        "thread-1 chef: Noted: zotac1070 and port 8780.",
        "thread-1 chef: Yes, I recorded the backup host too.",
      ]);

      subagent.waitForRun.mockResolvedValueOnce({ status: "timeout" });
      await reply("still there?");
      await runJob(answerJob);
      expect(fake.posts().at(-1)).toBe(
        "thread-1 Workboard: chef couldn't answer (no answer within 5 minutes). Your comment is saved on the card.",
      );
      expect(feed.health()).toMatchObject({ failures: 1 });

      await store.archive(card.id, true);
      await feed.sync();
      expect(subagent.deleteSession).toHaveBeenCalledWith({
        sessionKey: `agent:chef:workboard-thread:${card.id}`,
      });
    } finally {
      await feed.stop();
    }
  });
});
