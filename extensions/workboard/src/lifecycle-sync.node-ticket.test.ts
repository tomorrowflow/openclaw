// Workboard tests cover how a node ticket's run ending maps onto its card.
import { describe, expect, it } from "vitest";
import { syncWorkboardAgentEnded } from "./lifecycle-sync.js";
import { runSessionSweep } from "./lifecycle-sync.test-support.js";
import { endedSession, startNodeCard } from "./node-ticket.test-support.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";
import { projectWorkboardTrust } from "./trust-kpis.js";

describe("Workboard node ticket lifecycle", () => {
  const report = (value: unknown) => [
    { role: "user", content: "Work on this ticket" },
    {
      role: "assistant",
      content: [
        { type: "text", text: `Done.\n\n\`\`\`workboard-report\n${JSON.stringify(value)}\n\`\`\`` },
      ],
    },
  ];

  it.each([
    {
      name: "a done report with passing proof waits running for the bundle import",
      success: true,
      messages: report({
        outcome: "done",
        summary: "Parser accepts empty input",
        proof: [{ command: "pytest", status: "passed" }],
      }),
      status: "running",
      comment: "Parser accepts empty input",
    },
    {
      name: "open questions wait in review with the questions",
      success: true,
      messages: report({
        outcome: "needs_input",
        summary: "Two schemas fit",
        questions: ["Keep v1 fields?"],
      }),
      status: "review",
      comment:
        "Needs input: Two schemas fit\n- Keep v1 fields?\n\nAnswer in a comment, then move the card to todo; the same session resumes with the answer.",
    },
    {
      name: "done with failing proof blocks the card",
      success: true,
      messages: report({
        outcome: "done",
        summary: "Tried",
        proof: [{ command: "pytest", status: "failed" }],
      }),
      status: "blocked",
      comment: "Reported done without passing proof: Tried",
    },
    {
      name: "done with only skipped proof blocks the card",
      success: true,
      messages: report({
        outcome: "done",
        summary: "Untested",
        proof: [{ command: "pytest", status: "skipped" }],
      }),
      status: "blocked",
      comment: "Reported done without passing proof: Untested",
    },
    {
      name: "a final message without a report blocks the card",
      success: true,
      messages: [{ role: "assistant", content: "All done!" }],
      status: "blocked",
      comment: "The ticket session ended without a workboard-report block.",
    },
    {
      name: "a failed run without a report blocks the card",
      success: false,
      messages: [],
      status: "blocked",
      comment:
        "The ticket session failed. The ticket session ended without a workboard-report block.",
    },
  ])("maps node ticket endings: $name", async ({ success, messages, status, comment }) => {
    const store = createWorkboardSqliteTestStore();
    const { card, sessionKey, runId } = await startNodeCard(store);

    await syncWorkboardAgentEnded({
      store,
      event: { runId, success, messages },
      context: { runId, sessionKey },
      readSessions: endedSession(),
    });

    const stored = await store.get(card.id);
    expect(stored?.status).toBe(status);
    expect(stored?.metadata?.comments?.at(-1)?.body).toBe(comment);
  });

  it.each([
    {
      name: "a block reason longer than an attempt error",
      value: { outcome: "blocked", summary: "x".repeat(900), questions: ["Run pytest?"] },
      lead: "Blocked: xxx",
    },
    {
      name: "a block reason longer than a comment",
      value: { outcome: "blocked", summary: "x".repeat(1500), questions: ["y".repeat(1500)] },
      lead: "Blocked: xxx",
    },
    {
      name: "failing proof with oversized report fields",
      value: {
        outcome: "done",
        summary: "x".repeat(3000),
        proof: [{ command: "c".repeat(1500), status: "failed", note: "n".repeat(3000) }],
      },
      lead: "Reported done without passing proof: xxx",
    },
  ])("blocks a node ticket on $name", async ({ value, lead }) => {
    const store = createWorkboardSqliteTestStore();
    const { card, sessionKey, runId } = await startNodeCard(store);

    await syncWorkboardAgentEnded({
      store,
      event: { runId, success: true, messages: report(value) },
      context: { runId, sessionKey },
      readSessions: endedSession(),
    });

    const stored = await store.get(card.id);
    expect(stored?.status).toBe("blocked");
    const comment = stored?.metadata?.comments?.at(-1)?.body ?? "";
    expect(comment.startsWith(lead)).toBe(true);
    expect(comment.length).toBeLessThanOrEqual(2000);
    const attempt = stored?.metadata?.attempts?.at(-1);
    expect(attempt?.status).toBe("blocked");
    expect(attempt?.error?.length).toBeLessThanOrEqual(800);
    expect(attempt?.error?.startsWith(lead)).toBe(true);
  });

  it("records an operator stop of a node ticket as stopped, not failed", async () => {
    const store = createWorkboardSqliteTestStore();
    const { card, sessionKey, runId } = await startNodeCard(store);
    await store.nodeTicketStop(card.id, { action: "request" });

    await syncWorkboardAgentEnded({
      store,
      event: { runId, success: false, messages: [] },
      context: { runId, sessionKey },
      readSessions: endedSession(false),
    });
    await runSessionSweep({
      store,
      sessions: [
        { key: sessionKey, status: "killed", abortedLastRun: true, updatedAt: Date.now() },
      ],
    });

    const stored = await store.get(card.id);
    expect(stored?.status).toBe("todo");
    expect(stored?.sessionKey).toBe(sessionKey);
    expect(stored?.metadata?.failureCount ?? 0).toBe(0);
    expect(stored?.metadata?.attempts?.at(-1)?.status).toBe("stopped");
    expect(stored?.metadata?.comments?.at(-1)?.body).toMatch(/^Stopped by the operator\./);
    expect(stored?.events?.some((event) => event.toStatus === "blocked")).toBe(false);
    expect(projectWorkboardTrust([stored!], "default", Date.now()).total.blocked).toBe(0);
  });

  it("waits through a failed attempt while fallback continues, then maps the final report", async () => {
    const store = createWorkboardSqliteTestStore();
    const { card, sessionKey, runId } = await startNodeCard(store);
    const stillRunning = async () => ({
      sessions: [{ key: sessionKey, status: "running" as const, hasActiveRun: true }],
      complete: true,
    });

    await syncWorkboardAgentEnded({
      store,
      event: { runId, success: false, messages: [] },
      context: { runId, sessionKey },
      readSessions: stillRunning,
    });
    expect((await store.get(card.id))?.status).toBe("running");

    await syncWorkboardAgentEnded({
      store,
      event: {
        runId,
        success: true,
        messages: report({
          outcome: "done",
          summary: "Fixed",
          proof: [{ command: "pytest", status: "passed" }],
        }),
      },
      context: { runId, sessionKey },
      readSessions: stillRunning,
    });
    const settled = await store.get(card.id);
    expect(settled?.status).toBe("running");
    expect(settled?.metadata?.automation?.target?.worktree?.handoff?.phase).toBe("pending");
  });

  it("keeps a blocked node ticket's attempt blocked when the sweep later sees its session end", async () => {
    const store = createWorkboardSqliteTestStore();
    const { card, sessionKey, runId } = await startNodeCard(store);
    await syncWorkboardAgentEnded({
      store,
      event: { runId, success: true, messages: [{ role: "assistant", content: "All done!" }] },
      context: { runId, sessionKey },
      readSessions: endedSession(),
    });
    expect((await store.get(card.id))?.metadata?.attempts?.at(-1)?.status).toBe("blocked");

    await runSessionSweep({
      store,
      sessions: [
        { key: sessionKey, status: "done", hasActiveRun: false, updatedAt: Date.now() + 20_000 },
      ],
    });

    const swept = await store.get(card.id);
    expect(swept?.status).toBe("blocked");
    expect(swept?.metadata?.attempts?.at(-1)).toMatchObject({
      runId,
      status: "blocked",
      error: expect.stringMatching(/workboard-report/),
    });
  });

  it("leaves a finished node ticket running when only the sweep saw it end", async () => {
    const store = createWorkboardSqliteTestStore();
    const { card, sessionKey } = await startNodeCard(store);

    await runSessionSweep({
      store,
      sessions: [{ key: sessionKey, status: "done", updatedAt: card.updatedAt + 1_000 }],
    });

    expect((await store.get(card.id))?.status).toBe("running");
  });
});
