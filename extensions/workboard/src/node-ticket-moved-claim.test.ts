import { describe, expect, it, vi } from "vitest";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import { syncWorkboardAgentEnded } from "./lifecycle-sync.js";
import { runSessionSweep } from "./lifecycle-sync.test-support.js";
import { createNodeGateway, endedSession, startNodeCard } from "./node-ticket.test-support.js";
import type { WorkboardStore } from "./store.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";
import { createWorkboardTools } from "./tools.js";

type RunEnd = (params: {
  store: WorkboardStore;
  sessionKey: string;
  runId: string;
}) => Promise<unknown>;

const agentEnd = (
  store: WorkboardStore,
  sessionKey: string,
  runId: string,
  session: { status?: "running" | "done"; hasActiveRun: boolean },
  allowIdleRunningTerminal = false,
) =>
  syncWorkboardAgentEnded({
    store,
    event: { runId, success: true, messages: [] },
    context: { runId, sessionKey },
    allowIdleRunningTerminal,
    readSessions: async () => ({
      sessions: [{ key: sessionKey, ...session, updatedAt: Date.now() }],
      complete: true,
    }),
  });

const RUN_ENDS: Array<[string, RunEnd]> = [
  [
    "agent_end on a finished session",
    ({ store, sessionKey, runId }) =>
      syncWorkboardAgentEnded({
        store,
        event: { runId, success: true, messages: [] },
        context: { runId, sessionKey },
        readSessions: endedSession(),
      }),
  ],
  [
    "the agent_end retry once the session settles",
    async ({ store, sessionKey, runId }) => {
      await agentEnd(store, sessionKey, runId, { status: "running", hasActiveRun: true });
      await agentEnd(store, sessionKey, runId, { status: "running", hasActiveRun: false }, true);
    },
  ],
  [
    "a sweep of the done session",
    ({ store, sessionKey }) =>
      runSessionSweep({
        store,
        sessions: [{ key: sessionKey, status: "done", hasActiveRun: false, updatedAt: Date.now() }],
      }),
  ],
  [
    "a sweep of the settled session",
    ({ store, sessionKey }) =>
      runSessionSweep({
        store,
        sessions: [{ key: sessionKey, hasActiveRun: false, updatedAt: Date.now() }],
      }),
  ],
];

describe("node ticket moved out of running mid-run", () => {
  it.each(RUN_ENDS)("stays fenced until %s releases its claim", async (_label, endRun) => {
    const store = createWorkboardSqliteTestStore();
    const nodeTickets = createNodeGateway();
    const { card, sessionKey, runId } = await startNodeCard(store, nodeTickets);
    const tools = new Map(
      createWorkboardTools({ store, context: { agentId: "dev" } }).map((tool) => [tool.name, tool]),
    );
    const restart = async () => {
      await store.move(card.id, "todo", undefined);
      return await dispatchAndStartWorkboardCards({
        store,
        subagent: { run: vi.fn() },
        nodeTickets,
        options: { cardId: card.id },
      });
    };

    await tools.get("workboard_move")?.execute("move-review", { id: card.id, status: "review" });
    expect((await restart()).startFailures).toEqual([
      expect.objectContaining({ error: "Card is already claimed by dev." }),
    ]);

    await endRun({ store, sessionKey, runId });

    expect((await store.get(card.id))?.metadata?.claim).toBeUndefined();
    const restarted = await restart();
    expect(restarted.startFailures).toEqual([]);
    expect(restarted.started).toEqual([expect.objectContaining({ cardId: card.id })]);
  });
});
