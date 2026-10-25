import { expectDefined } from "@openclaw/normalization-core";
// Workboard tests cover how a node ticket's run ending maps onto its card.
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { describe, expect, it, vi } from "vitest";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import { syncWorkboardAgentEnded } from "./lifecycle-sync.js";
import { runSessionSweep } from "./lifecycle-sync.test-support.js";
import { nodeTicketTarget } from "./node-ticket.js";
import {
  createNodeGateway,
  endedSession,
  settledSession,
  startNodeCard,
} from "./node-ticket.test-support.js";
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
        "**Needs input:** Two schemas fit\n\n- Keep v1 fields?\n\nAnswer in a comment, then move the card to todo; the same session resumes with the answer.",
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
      name: "a done report closed with a stray brace still counts",
      success: true,
      messages: [
        {
          role: "assistant",
          content: `\`\`\`workboard-report\n${JSON.stringify({
            outcome: "done",
            summary: "Parser accepts empty input",
            proof: [{ command: "pytest", status: "passed" }],
            decisions: [
              {
                ts: "2026-10-25",
                phase: "verify",
                decision: "Full suite, ruff and diff check on the final commit",
                why: "Required proof",
                evidence: "949 passed, 11 skipped; ruff clean; git diff --check clean",
                result: "Passed",
              },
            ],
          })}}\n\`\`\``,
        },
      ],
      status: "running",
      comment: "Parser accepts empty input",
    },
    {
      name: "a report that is not valid JSON names the parse error",
      success: true,
      messages: [{ role: "assistant", content: '```workboard-report\n{"outcome":"done"}}}}\n```' }],
      status: "blocked",
      comment:
        "The ticket session's workboard-report block is not valid JSON: Unexpected non-whitespace character after JSON at position 18 (line 1 column 19).",
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
      name: "while the session is still finishing",
      readSessions: async (options: { sessionKey?: string }) => ({
        sessions: options.sessionKey
          ? [{ key: options.sessionKey, hasActiveRun: true, updatedAt: Date.now() }]
          : [],
        complete: true,
      }),
    },
    { name: "after the session ended", readSessions: endedSession() },
  ])("wakes the board automation once for a question round $name", async ({ readSessions }) => {
    const store = createWorkboardSqliteTestStore();
    const { card, sessionKey, runId } = await startNodeCard(store);
    const onMatched = vi.fn<
      NonNullable<Parameters<typeof syncWorkboardAgentEnded>[0]["onMatched"]>
    >(async () => {});

    await syncWorkboardAgentEnded({
      store,
      event: {
        runId,
        success: true,
        messages: report({ outcome: "needs_input", summary: "Two schemas fit", questions: ["Q1"] }),
      },
      context: { runId, sessionKey },
      readSessions,
      onMatched,
    });

    expect(onMatched).toHaveBeenCalledTimes(1);
    expect(onMatched).toHaveBeenCalledWith({
      cards: [expect.objectContaining({ id: card.id, status: "review" })],
      sessionKey,
    });
  });

  it("leaves a done report's wake-up to its bundle import", async () => {
    const store = createWorkboardSqliteTestStore();
    const { sessionKey, runId } = await startNodeCard(store);
    const onMatched = vi.fn<
      NonNullable<Parameters<typeof syncWorkboardAgentEnded>[0]["onMatched"]>
    >(async () => {});

    await syncWorkboardAgentEnded({
      store,
      event: {
        runId,
        success: true,
        messages: report({
          outcome: "done",
          summary: "Parser accepts empty input",
          proof: [{ command: "pytest", status: "passed" }],
        }),
      },
      context: { runId, sessionKey },
      readSessions: async () => ({
        sessions: [{ key: sessionKey, hasActiveRun: true, updatedAt: Date.now() }],
        complete: true,
      }),
      onMatched,
    });

    expect(onMatched).not.toHaveBeenCalled();
  });

  it("replaces the card summary with a done report's headline and keeps the summary a comment", async () => {
    const end = async (value: Record<string, unknown>) => {
      const store = createWorkboardSqliteTestStore();
      const { card, sessionKey, runId } = await startNodeCard(store);
      await store.update(card.id, { summary: "Empty input crashes the parser." });
      await syncWorkboardAgentEnded({
        store,
        event: { runId, success: true, messages: report(value) },
        context: { runId, sessionKey },
        readSessions: endedSession(),
      });
      return await store.get(card.id);
    };
    const done = {
      outcome: "done",
      summary: "Parser accepts empty input: `parse('')` returns `[]`.",
      proof: [{ command: "pytest", status: "passed" }],
    };

    const headlined = await end({
      ...done,
      headline: `The parser no longer crashes. ${"x".repeat(500)}`,
    });
    expect(headlined?.metadata?.automation?.summary).toMatch(
      /^The parser no longer crashes\. x+…$/,
    );
    expect(headlined?.metadata?.automation?.summary).toHaveLength(400);
    expect(headlined?.metadata?.comments?.at(-1)?.body).toBe(done.summary);

    const plain = await end(done);
    expect(plain?.metadata?.automation?.summary).toBe("Empty input crashes the parser.");

    // Only a done report the import will carry owns the summary.
    const blocked = await end({ ...done, outcome: "blocked", headline: "Gave up." });
    expect(blocked?.status).toBe("blocked");
    expect(blocked?.metadata?.automation?.summary).toBe("Empty input crashes the parser.");
  });

  it("records a report's decision trail on the worktree's round, a blocked one too", async () => {
    const end = async (value: Record<string, unknown>) => {
      const store = createWorkboardSqliteTestStore();
      const { card, sessionKey, runId } = await startNodeCard(store);
      await syncWorkboardAgentEnded({
        store,
        event: { runId, success: true, messages: report(value) },
        context: { runId, sessionKey },
        readSessions: endedSession(),
      });
      return nodeTicketTarget(expectDefined(await store.get(card.id), "card"))?.worktree;
    };

    const blocked = await end({
      outcome: "blocked",
      summary: "The fixture repo is missing",
      decisions: [
        { phase: "verify", decision: "pytest cannot import fixtures", evidence: "pytest -x" },
        { phase: "verify" },
      ],
    });
    expect(blocked?.rounds).toEqual([
      {
        round: 0,
        decisions: [
          { phase: "verify", decision: "pytest cannot import fixtures", evidence: "pytest -x" },
        ],
      },
    ]);

    const silent = await end({
      outcome: "done",
      summary: "Parser accepts empty input",
      proof: [{ command: "pytest", status: "passed" }],
    });
    expect(silent?.rounds).toBeUndefined();
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
    const before = (await store.get(card.id))?.metadata?.comments?.length ?? 0;

    await syncWorkboardAgentEnded({
      store,
      event: { runId, success: true, messages: report(value) },
      context: { runId, sessionKey },
      readSessions: endedSession(),
    });

    const stored = await store.get(card.id);
    expect(stored?.status).toBe("blocked");
    // The block comment leads the report; a long one continues in the comments after it.
    const comment = stored?.metadata?.comments?.[before]?.body ?? "";
    expect(comment.startsWith(lead)).toBe(true);
    expect(comment.length).toBeLessThanOrEqual(2000);
    const attempt = stored?.metadata?.attempts?.at(-1);
    expect(attempt?.status).toBe("blocked");
    expect(attempt?.error?.length).toBeLessThanOrEqual(800);
    expect(attempt?.error?.startsWith(lead)).toBe(true);
  });

  it.each([
    {
      name: "a question round",
      value: {
        outcome: "needs_input",
        summary: `The retry-only gap needs a call. ${"s".repeat(600)}`,
        questions: [
          `**Q1 – Delete the marker yourself:** ${"a".repeat(700)} ➡️ Yes; I then capture the run.`,
          `**Q2 – Or accept the gap:** ${"b".repeat(700)} ➡️ Yes; the README documents it.`,
        ],
      },
      status: "review",
      footer:
        "Answer in a comment, then move the card to todo; the same session resumes with the answer.",
    },
    {
      name: "a blocked report",
      value: {
        outcome: "blocked",
        summary: `The node lost its clone. ${"s".repeat(600)}`,
        questions: [`Re-clone? ${"a".repeat(900)}`, `Or move nodes? ${"b".repeat(900)}`],
      },
      status: "blocked",
      footer: undefined,
    },
    {
      name: "a done report's summary",
      value: {
        outcome: "done",
        summary: [
          "**What:**",
          `- ${"a".repeat(900)}`,
          `- ${"b".repeat(900)}`,
          `**Why:** ${"c".repeat(600)}`,
        ].join("\n"),
        proof: [{ command: "pytest", status: "passed" }],
      },
      status: "running",
      footer: undefined,
    },
    {
      name: "a run-on question",
      value: {
        outcome: "needs_input",
        summary: "One long fork.",
        questions: [`**Q1 – Pick the schema:** ${"word ".repeat(700)}➡️ Yes; keep v1.`],
      },
      status: "review",
      footer:
        "Answer in a comment, then move the card to todo; the same session resumes with the answer.",
    },
  ])("keeps every line of $name past one comment's limit", async ({ value, status, footer }) => {
    const store = createWorkboardSqliteTestStore();
    const { card, sessionKey, runId } = await startNodeCard(store);
    const before = (await store.get(card.id))?.metadata?.comments?.length ?? 0;

    await syncWorkboardAgentEnded({
      store,
      event: { runId, success: true, messages: report(value) },
      context: { runId, sessionKey },
      readSessions: endedSession(),
    });

    const stored = await store.get(card.id);
    expect(stored?.status).toBe(status);
    const bodies = (stored?.metadata?.comments ?? []).slice(before).map((comment) => comment.body);
    expect(bodies.length).toBeGreaterThan(1);
    for (const body of bodies) {
      expect(body.length).toBeLessThanOrEqual(2000);
    }
    // A line too long for one comment continues in the next one.
    const text = bodies.join("").replace(/\s/g, "");
    const lines = [
      ...value.summary.split("\n"),
      ...("questions" in value ? (value.questions ?? []) : []),
    ];
    for (const line of lines) {
      expect(text).toContain(line.replace(/\s/g, ""));
    }
    expect(text).not.toContain("…");
    expect(text).not.toContain("(cut,");
    if (footer) {
      expect(bodies.at(-1)?.endsWith(footer)).toBe(true);
    }
  });

  it("bounds a question round that overshoots the card's budget and says where the rest is", async () => {
    const store = createWorkboardSqliteTestStore();
    const { card, sessionKey, runId } = await startNodeCard(store);
    const before = (await store.get(card.id))?.metadata?.comments?.length ?? 0;
    const questions = Array.from(
      { length: 20 },
      (_, index) => `**Q${index + 1}:** ${"q".repeat(1500)}`,
    );

    await syncWorkboardAgentEnded({
      store,
      event: {
        runId,
        success: true,
        messages: report({ outcome: "needs_input", summary: "Many forks.", questions }),
      },
      context: { runId, sessionKey },
      readSessions: endedSession(),
    });

    const stored = await store.get(card.id);
    expect(stored?.status).toBe("review");
    const bodies = (stored?.metadata?.comments ?? []).slice(before).map((comment) => comment.body);
    expect(bodies).toHaveLength(3);
    expect(bodies[0]?.startsWith("**Needs input:** Many forks.")).toBe(true);
    expect(bodies.at(-1)).toMatch(
      /\(cut, \d+ chars dropped; the full report is in the ticket session's final message\)\n\nAnswer in a comment, then move the card to todo; the same session resumes with the answer\.$/,
    );
    for (const body of bodies) {
      expect(body.length).toBeLessThanOrEqual(2000);
    }
  });

  it("marks a proof note cut to the store limit", async () => {
    const store = createWorkboardSqliteTestStore();
    const { card, sessionKey, runId } = await startNodeCard(store);

    await syncWorkboardAgentEnded({
      store,
      event: {
        runId,
        success: true,
        messages: report({
          outcome: "done",
          summary: "Parser accepts empty input",
          proof: [{ command: "pytest", status: "passed", note: "n".repeat(3000) }],
        }),
      },
      context: { runId, sessionKey },
      readSessions: endedSession(),
    });

    const note = (await store.get(card.id))?.metadata?.proof?.at(-1)?.note ?? "";
    expect(note.length).toBeLessThanOrEqual(2000);
    expect(note).toMatch(
      /^n+ \(cut, \d+ chars dropped; the full report is in the ticket session's final message\)$/,
    );
  });

  it("needs the standards review in a rung b round's done report and records it as proof", async () => {
    const done = (review?: unknown) =>
      report({
        outcome: "done",
        summary: "Docs page updated",
        proof: [{ command: "pnpm docs:check", status: "passed" }],
        ...(review ? { review } : {}),
      });
    const end = async (messages: unknown[]) => {
      const store = createWorkboardSqliteTestStore();
      await store.upsertBoard({
        id: "default",
        orchestration: { classRungs: { docs: { rung: "b" } } },
      });
      const { card, sessionKey, runId } = await startNodeCard(store, undefined, undefined, [
        "class:docs",
      ]);
      await syncWorkboardAgentEnded({
        store,
        event: { runId, success: true, messages },
        context: { runId, sessionKey },
        readSessions: endedSession(),
      });
      return await store.get(card.id);
    };

    const unreviewed = await end(done());
    expect(unreviewed?.status).toBe("blocked");
    expect(unreviewed?.metadata?.comments?.at(-1)?.body).toBe(
      "Reported done without the standards review its rung b brief asked for: Docs page updated\nRe-run the card; the next run reuses the node worktree, and its brief asks for the reviewer against CODING_STANDARDS.md and a `review` in the report.",
    );

    // Fewer fixed than found is recorded for the reviewer, not blocked. Counts
    // without items are the brief before itemized findings; a resumed session still sends them.
    const reviewed = await end(done({ findings: 3, fixed: 2, note: "Kept the long table" }));
    expect(reviewed?.status).toBe("running");
    expect(
      reviewed?.metadata?.proof?.map(({ label, status, note }) => ({ label, status, note })),
    ).toEqual([
      { label: "ticket proof", status: "passed", note: undefined },
      {
        label: "standards review",
        status: "passed",
        note: "3 findings, 2 fixed. Kept the long table",
      },
    ]);
    const worktree = nodeTicketTarget(expectDefined(reviewed, "reviewed card"))?.worktree;
    expect(worktree?.handoff?.phase).toBe("pending");
    expect(worktree?.rounds).toEqual([
      { round: 0, review: { findings: 3, fixed: 2, note: "Kept the long table" } },
    ]);

    // Items carry the counts: invalid ones are dropped, the open ones kept first under the cap.
    const finding = (index: number, fixed: boolean) => ({
      path: `src/file-${index}.ts`,
      line: index + 1,
      rule: "Name the why",
      body: `Finding ${index}`,
      fixed,
    });
    const items = [
      ...Array.from({ length: 10 }, (_, index) => finding(index, true)),
      ...Array.from({ length: 4 }, (_, index) => finding(10 + index, false)),
      { path: "src/a.ts", line: 0, body: "No line" },
      { path: "src/a.ts", line: 2.5, body: "Fractional line" },
      { line: 3, body: "No path" },
      { path: "src/a.ts", line: 3, body: "  " },
      { path: `${"d/".repeat(81)}a.ts`, line: 3, body: "Path too long to trace" },
      { path: "/repo/src/a.ts", line: 3, body: "Absolute path" },
      { path: "src/../../a.ts", line: 3, body: "Outside the repo" },
    ];
    const itemized = await end(done({ items, note: "Left four" }));
    expect(itemized?.status).toBe("running");
    expect(itemized?.metadata?.proof?.at(-1)?.note).toBe(
      "14 findings, 10 fixed. Left four (7 malformed findings dropped)",
    );
    const review = nodeTicketTarget(expectDefined(itemized, "itemized card"))?.worktree?.rounds?.[0]
      ?.review;
    expect(review).toEqual({
      findings: 14,
      fixed: 10,
      note: "Left four (7 malformed findings dropped)",
      items: [...items.slice(10, 14), ...items.slice(0, 8)],
    });

    // A clean review sends no items; one whose items were all malformed must not read as clean.
    const clean = await end(done({ items: [] }));
    expect(clean?.metadata?.proof?.at(-1)?.note).toBe("0 findings, 0 fixed");
    const unreadable = await end(done({ items: [{ path: "../a.ts", line: 1, body: "Outside" }] }));
    expect(unreadable?.status).toBe("running");
    expect(unreadable?.metadata?.proof?.at(-1)?.note).toBe(
      "0 findings, 0 fixed. (1 malformed finding dropped)",
    );
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

  it("releases a failed run's claim so the card restarts after a move to todo", async () => {
    const store = createWorkboardSqliteTestStore();
    const nodeTickets = createNodeGateway();
    const { card, sessionKey, runId } = await startNodeCard(store, nodeTickets);
    // The CLI runner failed; agent_end fires while fallback may still continue.
    await syncWorkboardAgentEnded({
      store,
      event: { runId, success: false, messages: [] },
      context: { runId, sessionKey },
      readSessions: async () => ({
        sessions: [{ key: sessionKey, status: "running" as const, hasActiveRun: true }],
        complete: true,
      }),
    });
    await runSessionSweep({
      store,
      sessions: [
        { key: sessionKey, status: "failed", hasActiveRun: false, updatedAt: Date.now() + 1_000 },
      ],
    });
    const failed = await store.get(card.id);
    expect(failed?.status).toBe("blocked");
    expect(failed?.metadata?.claim).toBeUndefined();

    await store.move(card.id, "todo", undefined);
    const restarted = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run: vi.fn() },
      nodeTickets,
      options: { now: Date.now(), maxStarts: 1, cardId: card.id },
    });
    expect(restarted.startFailures).toEqual([]);
    expect(restarted.started.map((run) => run.cardId)).toEqual([card.id]);
  });

  it("leaves a restarted round running when the previous run's failure is observed late", async () => {
    const store = createWorkboardSqliteTestStore();
    const nodeTickets = createNodeGateway();
    const respond = expectDefined(nodeTickets.respond.getMockImplementation(), "respond");
    let runs = 0;
    nodeTickets.respond.mockImplementation((method, params) => {
      const reply = respond(method, params);
      return method === "sessions.create" && isRecord(reply)
        ? { ...reply, runId: `run-node-${++runs}` }
        : reply;
    });
    const { card, sessionKey } = await startNodeCard(store, nodeTickets);
    const first = expectDefined((await store.get(card.id))?.metadata?.claim, "claim");
    await store.block(card.id, { reason: "node restarted" }, first);
    await store.move(card.id, "ready", undefined);
    const restarted = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run: vi.fn() },
      nodeTickets,
      options: { now: Date.now(), maxStarts: 1, cardId: card.id },
    });
    expect(restarted.startFailures).toEqual([]);
    const second = expectDefined((await store.get(card.id))?.metadata?.claim, "claim");

    await runSessionSweep({
      store,
      sessions: [
        {
          key: sessionKey,
          status: "failed",
          hasActiveRun: false,
          updatedAt: second.claimedAt - 1,
        },
      ],
    });

    const stored = await store.get(card.id);
    expect(stored?.status).toBe("running");
    expect(stored?.metadata?.claim?.token).toBe(second.token);
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

  it("blocks a node ticket whose failed run settled its session without a report", async () => {
    const store = createWorkboardSqliteTestStore();
    const { card, sessionKey, runId } = await startNodeCard(store);
    const settled = settledSession(sessionKey);

    // The aborted run's end waits for a fallback; the session then stays idle.
    await syncWorkboardAgentEnded({
      store,
      event: { runId, success: false, messages: [] },
      context: { runId, sessionKey },
      readSessions: settled.readSessions,
    });
    // The first sweep only closes the attempt: a retry of the same session
    // may start right after the abort, and its report must still land.
    await runSessionSweep({ store, sessions: [settled.session] });
    const swept = await store.get(card.id);
    expect(swept?.status).toBe("running");
    expect(swept?.metadata?.attempts?.at(-1)).toMatchObject({ runId, status: "stopped" });

    await runSessionSweep({ store, sessions: [settled.session] });
    const stored = await store.get(card.id);
    expect(stored?.status).toBe("blocked");
    expect(stored?.metadata?.comments?.at(-1)?.body).toBe(
      "The ticket session settled without a workboard-report block and nothing resumed it. The run was aborted or failed, or its report never reached the board. Check the node, then comment what to do next and move the card to todo to restart; the next run reuses the worktree.",
    );
    expect(stored?.metadata?.attempts?.at(-1)).toMatchObject({
      runId,
      status: "blocked",
      error: expect.stringMatching(/^The ticket session settled/),
    });
    expect(stored?.metadata?.failureCount).toBe(1);
    expect(stored?.events?.some((event) => event.toStatus === "blocked")).toBe(true);
  });

  it("still blocks a settled node ticket when the session moved after its attempt closed", async () => {
    const store = createWorkboardSqliteTestStore();
    const { card, sessionKey, runId } = await startNodeCard(store);
    const settled = settledSession(sessionKey);
    // A retry turn ran and ended between two sweeps without a report.
    const moved = { ...settled.session, updatedAt: settled.session.updatedAt + 5_000 };

    await syncWorkboardAgentEnded({
      store,
      event: { runId, success: false, messages: [] },
      context: { runId, sessionKey },
      readSessions: settled.readSessions,
    });
    await runSessionSweep({ store, sessions: [settled.session] });
    await runSessionSweep({ store, sessions: [moved] });
    expect((await store.get(card.id))?.status).toBe("running");

    await runSessionSweep({ store, sessions: [moved] });
    expect((await store.get(card.id))?.status).toBe("blocked");
  });

  it("settles on the retry's done report when a sweep saw the session idle between abort and retry", async () => {
    const store = createWorkboardSqliteTestStore();
    const { card, sessionKey, runId } = await startNodeCard(store);
    const settled = settledSession(sessionKey);
    const resumed = { ...settled.session, updatedAt: settled.session.updatedAt + 5_000 };
    const done = report({
      outcome: "done",
      summary: "Fixed",
      proof: [{ command: "pytest", status: "passed" }],
    });

    await syncWorkboardAgentEnded({
      store,
      event: { runId, success: false, messages: [] },
      context: { runId, sessionKey },
      readSessions: settled.readSessions,
    });
    await runSessionSweep({ store, sessions: [settled.session] });
    // The retry resumed the session, which moved on, and reported done.
    await syncWorkboardAgentEnded({
      store,
      event: { runId, success: true, messages: done },
      context: { runId, sessionKey },
      readSessions: async () => ({ sessions: [resumed], complete: true }),
    });
    await runSessionSweep({ store, sessions: [resumed] });

    const stored = await store.get(card.id);
    expect(stored?.status).toBe("running");
    expect(nodeTicketTarget(expectDefined(stored, "card"))?.worktree?.handoff?.phase).toBe(
      "pending",
    );
    expect(stored?.events?.some((event) => event.toStatus === "blocked")).toBe(false);
  });

  it("settles on a stalled-turn retry's done report under a new run id", async () => {
    const store = createWorkboardSqliteTestStore();
    const { card, sessionKey, runId } = await startNodeCard(store);
    const claimedAt = expectDefined((await store.get(card.id))?.metadata?.claim, "claim").claimedAt;
    const settled = settledSession(sessionKey);
    const resumed = { ...settled.session, updatedAt: settled.session.updatedAt + 5_000 };
    const retryRunId = `${runId}-retry`;

    // The watchdog aborted the round's run; core queued a retry turn in the same session.
    await syncWorkboardAgentEnded({
      store,
      event: { runId, success: false, messages: [] },
      context: { runId, sessionKey },
      readSessions: settled.readSessions,
    });
    await runSessionSweep({ store, sessions: [settled.session] });
    // The retry ran under its own run id, from after the round's claim, and reported done.
    await syncWorkboardAgentEnded({
      store,
      event: {
        runId: retryRunId,
        success: true,
        messages: report({
          outcome: "done",
          summary: "Fixed",
          proof: [{ command: "pytest", status: "passed" }],
        }),
        durationMs: 60_000,
      },
      context: { runId: retryRunId, sessionKey },
      readSessions: async () => ({ sessions: [resumed], complete: true }),
      now: claimedAt + 90_000,
    });
    await runSessionSweep({ store, sessions: [resumed] });
    await runSessionSweep({ store, sessions: [resumed] });

    const stored = await store.get(card.id);
    expect(stored?.status).toBe("running");
    expect(nodeTicketTarget(expectDefined(stored, "card"))?.worktree?.handoff?.phase).toBe(
      "pending",
    );
    expect(stored?.metadata?.comments?.at(-1)?.body).toBe("Fixed");
    expect(stored?.events?.some((event) => event.toStatus === "blocked")).toBe(false);
  });

  it("still fences a run from before the current round's claim after a restart", async () => {
    const store = createWorkboardSqliteTestStore();
    const gateway = createNodeGateway();
    const respond = expectDefined(gateway.respond.getMockImplementation(), "respond");
    let runs = 0;
    gateway.respond.mockImplementation((method, params) => {
      const reply = respond(method, params);
      return method === "sessions.create" && isRecord(reply)
        ? { ...reply, runId: `run-node-${++runs}` }
        : reply;
    });
    const { card, sessionKey, runId: firstRunId } = await startNodeCard(store, gateway);
    // Round 1 ended without a report and was restarted as round 2.
    await syncWorkboardAgentEnded({
      store,
      event: { runId: firstRunId, success: true, messages: [{ role: "assistant", content: "ok" }] },
      context: { runId: firstRunId, sessionKey },
      readSessions: endedSession(),
    });
    expect((await store.get(card.id))?.status).toBe("blocked");
    await store.move(card.id, "ready", undefined);
    const restarted = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run: vi.fn() },
      nodeTickets: gateway,
      options: { now: Date.now(), maxStarts: 1 },
    });
    expect(restarted.startFailures).toEqual([]);
    const secondRunId = expectDefined(restarted.started[0], "restart").runId;
    expect(secondRunId).not.toBe(firstRunId);
    const claimedAt = expectDefined((await store.get(card.id))?.metadata?.claim, "claim").claimedAt;

    // A retry of round 1's run, started before the restart, ends with a done report.
    const staleRunId = `${firstRunId}-retry`;
    await syncWorkboardAgentEnded({
      store,
      event: {
        runId: staleRunId,
        success: true,
        messages: report({
          outcome: "done",
          summary: "Stale",
          proof: [{ command: "pytest", status: "passed" }],
        }),
        durationMs: 60_000,
      },
      context: { runId: staleRunId, sessionKey },
      readSessions: async () => ({
        sessions: [{ key: sessionKey, status: "running" as const, hasActiveRun: true }],
        complete: true,
      }),
      now: claimedAt + 30_000,
    });

    const stored = await store.get(card.id);
    expect(stored?.status).toBe("running");
    expect(stored?.runId).toBe(secondRunId);
    expect(nodeTicketTarget(expectDefined(stored, "card"))?.worktree?.handoff).toBeUndefined();
    expect(stored?.metadata?.comments?.some((comment) => comment.body === "Stale")).toBe(false);
  });

  it("keeps a done report's pending handoff running while its session stays idle", async () => {
    const store = createWorkboardSqliteTestStore();
    const { card, sessionKey, runId } = await startNodeCard(store);
    const settled = settledSession(sessionKey);

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
      readSessions: settled.readSessions,
    });
    await runSessionSweep({ store, sessions: [settled.session] });
    await runSessionSweep({ store, sessions: [settled.session] });

    const stored = await store.get(card.id);
    expect(stored?.status).toBe("running");
    expect(nodeTicketTarget(expectDefined(stored, "card"))?.worktree?.handoff?.phase).toBe(
      "pending",
    );
  });

  it("blocks a finished node ticket only when a second sweep still finds no report", async () => {
    const store = createWorkboardSqliteTestStore();
    const { card, sessionKey } = await startNodeCard(store);
    const session = { key: sessionKey, status: "done" as const, updatedAt: Date.now() };

    // The first idle observation leaves the agent_end report a full sweep to land.
    await runSessionSweep({ store, sessions: [session] });
    expect((await store.get(card.id))?.status).toBe("running");

    await runSessionSweep({ store, sessions: [session] });
    const stored = await store.get(card.id);
    expect(stored?.status).toBe("blocked");
    expect(stored?.metadata?.comments?.at(-1)?.body).toMatch(/^The ticket session settled/);
  });
});
