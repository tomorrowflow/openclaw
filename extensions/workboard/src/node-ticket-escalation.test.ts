// Workboard tests cover recording that a node ticket's open questions went to the operator.
import { describe, expect, it, vi } from "vitest";
import { syncWorkboardAgentEnded } from "./lifecycle-sync.js";
import { endedSession, startNodeCard } from "./node-ticket.test-support.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";
import { createWorkboardTools } from "./tools.js";

const questionsReport = [
  {
    role: "assistant",
    content: `Stopped.\n\n\`\`\`workboard-report\n${JSON.stringify({
      outcome: "needs_input",
      summary: "Signing is unclear",
      questions: ["Which signing identity? Default: none."],
    })}\n\`\`\``,
  },
];

function devTool(store: ReturnType<typeof createWorkboardSqliteTestStore>, name: string) {
  const tool = createWorkboardTools({ store, context: { agentId: "dev" } }).find(
    (entry) => entry.name === name,
  );
  if (!tool) {
    throw new Error(`missing tool ${name}`);
  }
  return tool;
}

describe("node ticket escalation", () => {
  it("records one escalation per questions round without adding an answer", async () => {
    const store = createWorkboardSqliteTestStore();
    const { card, sessionKey, runId } = await startNodeCard(store);
    await syncWorkboardAgentEnded({
      store,
      event: { runId, success: true, messages: questionsReport },
      context: { runId, sessionKey },
      readSessions: endedSession(),
    });
    const asked = await store.get(card.id);
    expect(asked?.status).toBe("review");
    const comments = asked?.metadata?.comments?.length;

    const escalate = devTool(store, "workboard_escalate");
    await escalate.execute("escalate", { id: card.id });
    const first = (await store.get(card.id))?.metadata?.automation?.target?.worktree?.handoff;
    expect(first).toMatchObject({ phase: "questions", escalatedAt: expect.any(Number) });

    // A later call must keep the first stamp, so give it a later clock.
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    await escalate.execute("again", { id: card.id });
    vi.restoreAllMocks();
    const escalated = await store.get(card.id);
    expect(escalated?.metadata?.automation?.target?.worktree?.handoff).toEqual(first);
    expect(escalated?.status).toBe("review");
    expect(escalated?.metadata?.comments).toHaveLength(comments ?? 0);
  });

  it("refuses a card that is not waiting with questions", async () => {
    const store = createWorkboardSqliteTestStore();
    const { card } = await startNodeCard(store);

    await expect(
      devTool(store, "workboard_escalate").execute("escalate", { id: card.id }),
    ).rejects.toThrow("only a node ticket waiting with questions can be escalated");
  });
});
