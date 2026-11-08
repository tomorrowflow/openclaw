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

  it("keeps the escalation and the latest round readable when old comments are long", async () => {
    const store = createWorkboardSqliteTestStore();
    const { card, sessionKey, runId } = await startNodeCard(store);
    for (let index = 0; index < 8; index += 1) {
      await store.addComment(card.id, { body: `Research ${index} ${"x".repeat(5_000)}` });
    }
    await syncWorkboardAgentEnded({
      store,
      event: { runId, success: true, messages: questionsReport },
      context: { runId, sessionKey },
      readSessions: endedSession(),
    });
    await devTool(store, "workboard_escalate").execute("escalate", { id: card.id });

    const result = (await devTool(store, "workboard_read").execute("read", { id: card.id })) as {
      content: Array<{ text: string }>;
    };
    const text = result.content[0]?.text ?? "";
    const read = JSON.parse(text) as {
      stage?: { kind: string; escalatedAt?: number };
      omittedComments?: Array<{ id: string; firstLine: string; chars: number }>;
      card: { metadata: { comments: Array<{ body: string }> } };
    };
    // The decision state leads the result, so a cut tool result still holds it.
    expect(read.stage).toMatchObject({ kind: "questions", escalatedAt: expect.any(Number) });
    expect(text.indexOf('"escalatedAt"')).toBeLessThan(2_000);
    expect(read.card.metadata.comments.at(-1)?.body).toContain("Which signing identity?");
    expect(read.omittedComments?.length).toBeGreaterThan(5);
    expect(text.length).toBeLessThan(32_000);
    const oldest = read.omittedComments?.[0];
    expect(oldest?.firstLine).toMatch(/^Research 0 x+…$/);
    const full = (await devTool(store, "workboard_read").execute("older", {
      id: card.id,
      commentIds: [oldest?.id],
    })) as { details: { comments: Array<{ body: string }> } };
    expect(full.details.comments).toEqual([
      expect.objectContaining({ body: `Research 0 ${"x".repeat(5_000)}` }),
    ]);

    const list = (await devTool(store, "workboard_list").execute("list", {})) as {
      details: { cards: Array<{ id: string; stage?: { escalatedAt?: number } }> };
    };
    expect(list.details.cards.find((entry) => entry.id === card.id)?.stage).toMatchObject({
      escalatedAt: expect.any(Number),
    });
  });

  it("refuses a card that is not waiting with questions", async () => {
    const store = createWorkboardSqliteTestStore();
    const { card } = await startNodeCard(store);

    await expect(
      devTool(store, "workboard_escalate").execute("escalate", { id: card.id }),
    ).rejects.toThrow("only a node ticket waiting with questions can be escalated");
  });
});
