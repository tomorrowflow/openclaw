import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { syncWorkboardAgentEnded } from "./lifecycle-sync.js";
import { startNodeCard, endedSession } from "./node-ticket.test-support.js";
import { WorkboardStore } from "./store.js";
import { createKernelStores } from "./test/sqlite-kernel.js";
import {
  createWorkboardSqliteTestHarness,
  createWorkboardSqliteTestStore,
} from "./test/sqlite-store.js";

describe("Workboard run context (smart zone)", () => {
  const usage = (cacheRead: number, extra: Record<string, unknown> = {}) => ({
    input: 2,
    output: 40,
    cacheRead,
    cacheWrite: 300,
    ...extra,
  });
  // The session's earlier run, which agent_end messages still carry.
  const history = [
    { role: "user", content: "Earlier round" },
    { role: "assistant", content: "Earlier answer", usage: usage(170_000) },
  ];
  it.each([
    {
      name: "the last reply after the run's prompt",
      messages: [
        ...history,
        { role: "user", content: "Fix the parser" },
        { role: "assistant", content: "Reading", usage: usage(60_000) },
        { role: "toolResult", content: "file" },
        { role: "assistant", content: "All done!", usage: usage(152_000) },
      ],
      contextTokens: 152_302,
      breaches: 1,
    },
    {
      name: "nothing for a run that failed before replying",
      messages: [...history, { role: "user", content: "Fix the parser" }],
      contextTokens: undefined,
      breaches: 0,
    },
    {
      name: "the last call's prompt when usage sums the turn's calls",
      messages: [
        { role: "user", content: "Fix the parser" },
        {
          role: "assistant",
          content: "All done!",
          usage: usage(1_200_000, {
            contextUsage: { state: "available", promptTokens: 61_000, totalTokens: 62_000 },
          }),
        },
      ],
      contextTokens: 61_000,
      breaches: 0,
    },
  ])("records turn-end context on the run's attempt: $name", async (testCase) => {
    const store = createWorkboardSqliteTestStore();
    const { card, sessionKey, runId } = await startNodeCard(store);

    await syncWorkboardAgentEnded({
      store,
      event: { runId, success: true, messages: testCase.messages },
      context: { runId, sessionKey },
      readSessions: endedSession(),
    });

    const attempt = (await store.get(card.id))?.metadata?.attempts?.find(
      (entry) => entry.runId === runId,
    );
    expect(attempt?.status).toBe("blocked");
    expect(attempt?.contextTokens).toBe(testCase.contextTokens);
    expect((await store.trust({})).total).toMatchObject({
      contextMeasured: testCase.contextTokens === undefined ? 0 : 1,
      smartZoneBreaches: testCase.breaches,
    });
  });

  it("adds the context column to a prior-schema database and keeps its attempts", async () => {
    const { store, dbPath } = createWorkboardSqliteTestHarness({
      createStores: createKernelStores,
    });
    const { card, sessionKey, runId } = await startNodeCard(store);
    await store.close();
    {
      using prior = new DatabaseSync(dbPath);
      prior.exec("ALTER TABLE workboard_card_attempts DROP COLUMN context_tokens");
    }

    const reopenedStores = createKernelStores(dbPath);
    const reopened = new WorkboardStore(reopenedStores.cards, reopenedStores);
    await syncWorkboardAgentEnded({
      store: reopened,
      event: {
        runId,
        success: true,
        messages: [{ role: "assistant", content: "Done", usage: { input: 5, cacheRead: 9000 } }],
      },
      context: { runId, sessionKey },
      readSessions: endedSession(),
    });

    expect((await reopened.get(card.id))?.metadata?.attempts).toEqual([
      expect.objectContaining({ runId, status: "blocked", contextTokens: 9005 }),
    ]);
    await reopened.close();
  });
});
