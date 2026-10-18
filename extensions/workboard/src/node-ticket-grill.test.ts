// Workboard tests cover a node ticket handing its grilling off to a grill session and back.
import type { WorkboardCard } from "@openclaw/workboard-contract";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { createWorkboardAutomationNudgeService } from "./automation-nudge.js";
import { redactOperatorCard } from "./card-redaction.js";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import { registerWorkboardGatewayMethods } from "./gateway.js";
import { syncWorkboardAgentEnded } from "./lifecycle-sync.js";
import { nudgeContext } from "./lifecycle-sync.test-support.js";
import { appendGrillLog, GRILL_LOG_FILE_NAME } from "./node-ticket-grill.js";
import { createNodeTicketHandoffs } from "./node-ticket-handoff.js";
import { createNodeGateway, endedSession, startNodeCard } from "./node-ticket.test-support.js";
import { cardRunId, cardSessionKey } from "./store-card-helpers.js";
import type { WorkboardStore } from "./store.js";
import { createGatewayMethodCapture } from "./test/gateway-methods.js";
import {
  createWorkboardSqliteTestHarness,
  createWorkboardSqliteTestStore,
} from "./test/sqlite-store.js";
import { createWorkboardTools } from "./tools.js";

function reportMessages(report: Record<string, unknown>) {
  return [
    {
      role: "assistant",
      content: `Handing off.\n\n\`\`\`workboard-report\n${JSON.stringify(report)}\n\`\`\``,
    },
  ];
}

const HANDOFF =
  "**Researched:** `src/parser.ts` splits on newlines.\n\n**Settled:** scope is the parser only.\n\n**First question:** should the parser accept empty input? Recommended: yes, return `[]`.";
const RESULT = "**Settled:** empty input returns `[]`; `None` raises `TypeError`.";

const grillReport = reportMessages({ outcome: "grill", summary: HANDOFF });

async function endTurn(store: WorkboardStore, cardId: string, messages: unknown[]) {
  const card = await store.get(cardId);
  const runId = card ? cardRunId(card) : undefined;
  await syncWorkboardAgentEnded({
    store,
    event: { runId, success: true, messages },
    context: { runId, sessionKey: card ? cardSessionKey(card) : undefined },
    readSessions: endedSession(),
  });
}

/** A turn that ended on the card's own session after it handed the grilling off. */
async function cardSessionTurn(store: WorkboardStore, cardId: string, reply: string) {
  const card = await store.get(cardId);
  const now = Date.now() + 1000;
  await syncWorkboardAgentEnded({
    store,
    event: {
      runId: `chat-${now}`,
      success: true,
      durationMs: 500,
      messages: [
        { role: "user", content: "Yes, return []." },
        { role: "assistant", content: reply },
      ],
    },
    context: { runId: `chat-${now}`, sessionKey: card ? cardSessionKey(card) : undefined },
    now,
    readSessions: endedSession(),
  });
}

/**
 * A node ticket that handed its grilling off; `open` runs the handoff pass
 * that creates the grill session. The fake Gateway answers `chat.history`
 * with `history`, and fails grill session creates while `failCreate` is set.
 */
async function grillingTicket(store = createWorkboardSqliteTestStore(), open = true) {
  const gateway = createNodeGateway();
  const answer = gateway.respond.getMockImplementation()!;
  let history: unknown[] = [];
  let failCreate: string | undefined;
  gateway.respond.mockImplementation((method, params) => {
    if (method === "chat.history") {
      return { messages: history };
    }
    if (method === "sessions.create" && String(params?.key).includes(":grill-") && failCreate) {
      throw new Error(failCreate);
    }
    return answer(method, params);
  });
  const { card, sessionKey } = await startNodeCard(store, gateway);
  await endTurn(store, card.id, grillReport);
  // Whether the grill session runs a turn, as the session owner reports it; "unreadable" makes the read fail.
  let replying: boolean | "unreadable" = false;
  const readSessions = async (options: { sessionKey?: string }) => {
    if (replying === "unreadable") {
      throw new Error("sessions.describe returned an invalid lifecycle snapshot");
    }
    return {
      sessions: options.sessionKey
        ? [
            {
              key: options.sessionKey,
              hasActiveRun: replying,
              status: replying ? ("running" as const) : ("done" as const),
              updatedAt: Date.now(),
            },
          ]
        : [],
      complete: false,
    };
  };
  const capture = createGatewayMethodCapture();
  (capture.api.runtime as { gateway: unknown }).gateway = gateway;
  registerWorkboardGatewayMethods({ api: capture.api, store, readSessions });
  const end = async () => {
    const respond = await capture.invoke("workboard.cards.grill.end", { id: card.id });
    return respond.mock.calls[0] as [boolean, unknown, { message?: string }?];
  };
  const warn = vi.fn();
  const handoffs = createNodeTicketHandoffs({
    store,
    runtime: gateway,
    github: { token: () => undefined },
    readSessions,
    start: async (cardId, queue) =>
      await dispatchAndStartWorkboardCards({
        store,
        subagent: { run: vi.fn() },
        nodeTickets: gateway,
        options: { cardId, queue },
      }),
  });
  if (open) {
    await handoffs.resume(warn);
  }
  const log = async () => {
    const attachmentId = worktreeOf(await store.get(card.id))?.grill?.attachmentId;
    const stored = attachmentId ? await store.getAttachment(attachmentId) : undefined;
    return stored ? Buffer.from(stored.contentBase64, "base64").toString("utf8") : undefined;
  };
  const creates = () =>
    gateway.respond.mock.calls.filter(([method]) => method === "sessions.create");
  const grillCreates = () =>
    creates().filter(([, params]) => String(params?.key).includes(":grill-"));
  const ticketLaunches = () =>
    creates().filter(([, params]) => !String(params?.key).includes(":grill-"));
  const brief = () => String(ticketLaunches().at(-1)?.[1]?.message).split("## Turn contract")[0];
  const grillDone = async (fromSessionKey: string | undefined, input: Record<string, unknown>) =>
    await createWorkboardTools({
      store,
      context: { agentId: "dev", ...(fromSessionKey ? { sessionKey: fromSessionKey } : {}) },
    })
      .find((tool) => tool.name === "workboard_grill_done")!
      .execute("grill-done", input);
  return {
    store,
    gateway,
    card,
    sessionKey,
    end,
    handoffs,
    warn,
    log,
    grillCreates,
    ticketLaunches,
    brief,
    grillDone,
    grillSessionKey: async () => worktreeOf(await store.get(card.id))?.grill?.sessionKey,
    setReplying: (value: typeof replying) => {
      replying = value;
    },
    setHistory: (messages: unknown[]) => {
      history = messages;
    },
    setFailCreate: (message: string | undefined) => {
      failCreate = message;
    },
  };
}

const worktreeOf = (card: WorkboardCard | undefined) =>
  card?.metadata?.automation?.target?.worktree;

// Log entries carry ISO times; the tests compare the log with them as <t>.
const untimed = (log: string | undefined) => log?.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "<t>");
const HANDOFF_LOG = `## Handoff 1\n\n${HANDOFF}\n`;

describe("node ticket grilling handoff", () => {
  it("logs the handoff and opens a normal grill session of the card's agent on the Gateway", async () => {
    const ticket = await grillingTicket(undefined, false);
    const { store, card } = ticket;
    expect(ticket.ticketLaunches()[0]?.[1]?.message).toContain(
      "Do not grill in this session: Workboard hands the grilling to a new session",
    );

    const handed = await store.get(card.id);
    expect(handed?.status).toBe("review");
    expect(handed?.metadata?.claim).toBeUndefined();
    expect(worktreeOf(handed)?.handoff).toMatchObject({ phase: "grilling" });
    expect(worktreeOf(handed)?.grill).toEqual({
      status: "open",
      rounds: 1,
      attachmentId: expect.any(String),
    });
    expect(handed?.metadata?.attachments).toEqual([
      expect.objectContaining({ fileName: GRILL_LOG_FILE_NAME, mimeType: "text/markdown" }),
    ]);
    expect(await ticket.log()).toBe(HANDOFF_LOG);

    await ticket.handoffs.resume(ticket.warn);
    await ticket.handoffs.resume(ticket.warn);

    expect(ticket.warn).not.toHaveBeenCalled();
    expect(ticket.grillCreates()).toHaveLength(1);
    const [, params] = ticket.grillCreates()[0]!;
    const key = `agent:dev:grill-${card.id.slice(0, 8)}-1`;
    expect(params).toEqual({
      key,
      agentId: "dev",
      idempotencyKey: `workboard:${card.id}:grill:1`,
      displayName: "Grill Fix the parser",
      message: expect.any(String),
    });
    expect(params?.message).toContain(
      "Grill the operator on this Workboard ticket: Fix the parser",
    );
    expect(params?.message).toContain(HANDOFF);
    expect(params?.message).toContain("Interview the operator one question at a time");
    expect(params?.message).toContain("Do not build anything");
    expect(params?.message).toContain("Call `workboard_grill_done`");

    const opened = await store.get(card.id);
    expect(opened?.status).toBe("review");
    expect(worktreeOf(opened)?.grill).toMatchObject({ status: "open", sessionKey: key });
    expect(redactOperatorCard(opened!)).toMatchObject({
      stage: { kind: "grilling", round: 1 },
      grill: { status: "open", rounds: 1, sessionKey: key },
    });
    expect(opened?.metadata?.comments?.at(-1)?.body).toBe(
      `**Grilling 1** runs in its own session, Grill Fix the parser (\`${key}\`). Open it from the card's Grilling tab; the result comes back here when the grilling ends.`,
    );
    expect(await ticket.log()).toBe(HANDOFF_LOG);
    expect(ticket.ticketLaunches()).toHaveLength(1);
  });

  it("blocks the card when its grill session cannot start, and retries after a move to todo", async () => {
    const ticket = await grillingTicket(undefined, false);
    ticket.setFailCreate("agent dev is not configured");

    await ticket.handoffs.resume(ticket.warn);

    const blocked = await ticket.store.get(ticket.card.id);
    expect(blocked?.status).toBe("blocked");
    expect(blocked?.metadata?.comments?.at(-1)?.body).toBe(
      "The grill session could not start: agent dev is not configured\nFix the cause, then move the card to todo to try again.",
    );
    expect(worktreeOf(blocked)?.grill?.sessionKey).toBeUndefined();

    ticket.setFailCreate(undefined);
    await ticket.store.move(ticket.card.id, "todo", undefined);
    await ticket.handoffs.resume(ticket.warn);
    await ticket.handoffs.resume(ticket.warn);

    expect(ticket.grillCreates()).toHaveLength(2);
    const retried = await ticket.store.get(ticket.card.id);
    expect(retried?.status).toBe("review");
    expect(worktreeOf(retried)?.grill?.sessionKey).toBe(
      `agent:dev:grill-${ticket.card.id.slice(0, 8)}-1`,
    );
  });

  it("blocks a grill report without a handoff", async () => {
    const store = createWorkboardSqliteTestStore();
    const { card } = await startNodeCard(store, createNodeGateway());

    await endTurn(store, card.id, reportMessages({ outcome: "grill", question: "Empty input?" }));

    const blocked = await store.get(card.id);
    expect(blocked?.status).toBe("blocked");
    expect(blocked?.metadata?.comments?.at(-1)?.body).toContain(
      "The ticket session's grill report has no handoff in `summary`.",
    );
  });

  it("blocks a grill report whose handoff could not be recorded", async () => {
    const store = createWorkboardSqliteTestStore();
    const { card } = await startNodeCard(store, createNodeGateway());
    vi.spyOn(store, "recordNodeGrillHandoff").mockResolvedValue(undefined);

    await endTurn(store, card.id, grillReport);

    const blocked = await store.get(card.id);
    expect(blocked?.status).toBe("blocked");
    expect(blocked?.metadata?.claim).toBeUndefined();
    expect(blocked?.metadata?.comments?.at(-1)?.body).toContain(
      "Handed off a grilling, but the card's node worktree changed before it could be recorded",
    );
  });

  it("ignores a turn on the card's own session while grilling", async () => {
    const ticket = await grillingTicket();
    const before = await ticket.store.get(ticket.card.id);

    await cardSessionTurn(
      ticket.store,
      ticket.card.id,
      `Agreed.\n\n\`\`\`workboard-report\n${JSON.stringify({ outcome: "done", summary: "x", proof: [{ status: "passed" }] })}\n\`\`\``,
    );

    const after = await ticket.store.get(ticket.card.id);
    expect(after?.status).toBe("review");
    expect(worktreeOf(after)?.grill).toEqual(worktreeOf(before)?.grill);
    expect(after?.metadata?.comments).toEqual(before?.metadata?.comments);
    expect(after?.metadata?.proof ?? []).toEqual([]);
    expect(await ticket.log()).toBe(HANDOFF_LOG);
  });

  it("bounces a move to todo while grilling back to review once", async () => {
    const ticket = await grillingTicket();

    for (const attempt of [1, 2]) {
      await ticket.store.move(ticket.card.id, "todo", undefined);
      await ticket.handoffs.resume(ticket.warn);
      expect((await ticket.store.get(ticket.card.id))?.status, `todo move ${attempt}`).toBe(
        "review",
      );
    }
    const notices = ((await ticket.store.get(ticket.card.id))?.metadata?.comments ?? []).filter(
      (comment) => comment.body.startsWith("Moved to todo"),
    );
    expect(notices.map((comment) => comment.body)).toEqual([
      "Moved to todo while grilling; the grilling goes on in its grill session. Finish it there, or choose End grilling on the card to let the agent continue with the grill session's last reply.",
    ]);
    expect(ticket.ticketLaunches()).toHaveLength(1);
    expect(ticket.grillCreates()).toHaveLength(1);
  });

  it("wakes the board automation for a questions round but not for a grilling handoff", async () => {
    const store = createWorkboardSqliteTestStore();
    await store.upsertBoard({ id: "default", automationJobId: "job-review" });
    const request = vi.fn().mockResolvedValue({ ok: true, ran: true });
    const service = createWorkboardAutomationNudgeService({ store });
    await service.start(nudgeContext(request));
    try {
      const end = async (messages: unknown[]) => {
        const { sessionKey, runId } = await startNodeCard(store);
        await syncWorkboardAgentEnded({
          store,
          event: { runId, success: true, messages },
          context: { runId, sessionKey },
          readSessions: endedSession(),
          onMatched: service.nudge,
        });
      };

      await end(grillReport);
      expect(request).not.toHaveBeenCalled();
      await end(reportMessages({ outcome: "needs_input", summary: "Two fit", questions: ["Q1"] }));
      expect(request).toHaveBeenCalledOnce();
    } finally {
      service.stop();
    }
  });
});

describe("grilling result from the grill session", () => {
  it("takes the result handoff from the grill session and resumes the ticket session with it", async () => {
    const ticket = await grillingTicket();
    const { store, card } = ticket;
    const grillKey = await ticket.grillSessionKey();

    const result = await ticket.grillDone(grillKey, { handoff: RESULT });

    expect(result.details).toMatchObject({ card: { id: card.id, status: "todo" } });
    const ended = await store.get(card.id);
    expect(ended?.status).toBe("todo");
    expect(worktreeOf(ended)?.grill).toEqual({
      status: "closed",
      rounds: 1,
      attachmentId: expect.any(String),
      sessionKey: grillKey,
      pending: { kind: "end", at: expect.any(Number) },
    });
    expect(untimed(await ticket.log())).toBe(
      `${HANDOFF_LOG}\n## Result\n\n**settled in the grill session** (<t>)\n\n${RESULT}\n`,
    );

    await ticket.handoffs.resume(ticket.warn);

    expect(ticket.warn).not.toHaveBeenCalled();
    expect((await store.get(card.id))?.status).toBe("running");
    expect(ticket.ticketLaunches()).toHaveLength(2);
    expect(ticket.ticketLaunches().at(-1)?.[1]).toMatchObject({ key: ticket.sessionKey });
    expect(ticket.brief()).toContain(
      `## Grilling ended\nThe grilling you handed off ended. Its result is below and in the card's grilling log (\`grilling.md\`).\n\nResult:\n\n${RESULT}\n\nNow carry out the ticket`,
    );

    await endTurn(
      store,
      card.id,
      reportMessages({
        outcome: "done",
        headline: "Parser only.",
        summary: "Parser returns [].",
        proof: [{ command: "pytest", status: "passed" }],
      }),
    );

    const done = await store.get(card.id);
    expect(worktreeOf(done)).toMatchObject({
      handoff: { phase: "pending" },
      grill: { status: "closed", rounds: 1 },
    });
    expect(worktreeOf(done)?.grill?.pending).toBeUndefined();
  });

  it("refuses a result from any session but the card's grill session", async () => {
    const ticket = await grillingTicket();
    const { store, card } = ticket;

    for (const from of [ticket.sessionKey, "agent:dev:intake-server-20261018", undefined]) {
      await expect(ticket.grillDone(from, { handoff: RESULT }), String(from)).rejects.toThrow(
        "No grilling runs in this session: only the grill session Workboard created for a card's live grilling can hand its result back.",
      );
      await expect(
        ticket.grillDone(from, { cardId: card.id, handoff: RESULT }),
        String(from),
      ).rejects.toThrow("No grilling runs in this session");
    }

    const waiting = await store.get(card.id);
    expect(waiting?.status).toBe("review");
    expect(worktreeOf(waiting)?.grill).toMatchObject({ status: "open" });
    expect(await ticket.log()).toBe(HANDOFF_LOG);
  });

  it("refuses a second result after the grilling ended", async () => {
    const ticket = await grillingTicket();
    const grillKey = await ticket.grillSessionKey();
    await ticket.grillDone(grillKey, { handoff: RESULT });

    await expect(ticket.grillDone(grillKey, { handoff: "Again." })).rejects.toThrow(
      "No grilling runs in this session",
    );
  });
});

describe("grilling ended by the operator", () => {
  it("takes the grill session's last reply as the result of End grilling", async () => {
    const ticket = await grillingTicket();
    const { store, card } = ticket;
    ticket.setHistory([
      { role: "user", content: "Let's wrap up." },
      { role: "assistant", content: [{ type: "text", text: RESULT }] },
      { role: "assistant", content: [{ type: "toolCall", name: "read" }] },
    ]);

    const [ok, result] = await ticket.end();

    expect(ok).toBe(true);
    expect(result).toMatchObject({ card: { status: "todo" } });
    expect(ticket.gateway.respond).toHaveBeenCalledWith("chat.history", {
      sessionKey: await ticket.grillSessionKey(),
      limit: 20,
    });
    expect(untimed(await ticket.log())).toBe(
      `${HANDOFF_LOG}\n## Result\n\n**ended by the operator** (<t>)\n\n${RESULT}\n`,
    );
    expect((await ticket.end())[2]?.message).toContain("This card is not grilling");

    await ticket.handoffs.resume(ticket.warn);

    expect(ticket.warn).not.toHaveBeenCalled();
    expect((await store.get(card.id))?.status).toBe("running");
    expect(ticket.ticketLaunches().at(-1)?.[1]).toMatchObject({ key: ticket.sessionKey });
    expect(ticket.brief()).toContain(`Result:\n\n${RESULT}\n`);
  });

  it("ends without a result when the grill session has not replied", async () => {
    const ticket = await grillingTicket();

    expect((await ticket.end())[0]).toBe(true);
    await ticket.handoffs.resume(ticket.warn);

    expect(untimed(await ticket.log())).toMatch(
      /\n## Result\n\n\*\*ended by the operator\*\* \(<t>\)\n\nNo result was handed back\.\n$/,
    );
    expect(ticket.brief()).toContain(
      "The grilling ended without a result; carry out the ticket with what you know.",
    );
  });

  it("refuses End grilling while the grill session replies, and when it cannot read it", async () => {
    const ticket = await grillingTicket();
    ticket.setReplying(true);

    const [ok, , error] = await ticket.end();

    expect(ok).toBe(false);
    expect(error?.message).toBe(
      "The agent is still replying in the grill session; end the grilling when it has answered.",
    );
    ticket.setReplying("unreadable");
    expect((await ticket.end())[2]?.message).toBe(
      "Could not read the grill session; try End grilling again. | sessions.describe returned an invalid lifecycle snapshot",
    );
    const waiting = await ticket.store.get(ticket.card.id);
    expect(waiting?.status).toBe("review");
    expect(worktreeOf(waiting)?.grill).toMatchObject({ status: "open" });

    ticket.setReplying(false);
    expect((await ticket.end())[0]).toBe(true);
  });

  it("ends a grilling moved to done with the last reply once the grill session answered", async () => {
    const ticket = await grillingTicket();
    const { store, card } = ticket;
    ticket.setReplying(true);

    await store.move(card.id, "done", undefined);
    await ticket.handoffs.resume(ticket.warn);

    const moved = await store.get(card.id);
    expect(moved?.status).toBe("done");
    expect(worktreeOf(moved)?.grill).toMatchObject({ status: "open" });
    expect(ticket.ticketLaunches()).toHaveLength(1);

    ticket.setHistory([{ role: "assistant", content: RESULT }]);
    ticket.setReplying(false);
    await ticket.handoffs.resume(ticket.warn);

    expect(ticket.warn).not.toHaveBeenCalled();
    const resumed = await store.get(card.id);
    expect(resumed?.status, "the same pass resumes the session").toBe("running");
    expect(worktreeOf(resumed)?.grill).toMatchObject({
      status: "closed",
      pending: { kind: "end" },
    });
    expect(untimed(await ticket.log())).toBe(
      `${HANDOFF_LOG}\n## Result\n\n**ended by the operator** (<t>)\n\n${RESULT}\n`,
    );
    expect(ticket.ticketLaunches()).toHaveLength(2);
    expect(ticket.brief()).toContain(`Result:\n\n${RESULT}\n`);
  });

  it("resumes a grilling settled in its grill session that the operator moved to done before it started", async () => {
    const ticket = await grillingTicket();
    const { store, card } = ticket;
    await ticket.grillDone(await ticket.grillSessionKey(), { handoff: RESULT });

    await store.move(card.id, "done", undefined);
    await ticket.handoffs.resume(ticket.warn);

    expect(ticket.warn).not.toHaveBeenCalled();
    expect((await store.get(card.id))?.status).toBe("running");
    expect(ticket.brief()).toContain(`Result:\n\n${RESULT}\n`);
  });

  it("never takes a turn that started before the relaunch as the relaunched round's report", async () => {
    const ticket = await grillingTicket();
    const { store, card, gateway } = ticket;
    expect((await ticket.end())[0]).toBe(true);
    // The relaunch waits in sessions.create while an earlier turn on the card session ends.
    const answer = gateway.respond.getMockImplementation()!;
    const relaunching = createDeferred<void>();
    const released = createDeferred<void>();
    gateway.respond.mockImplementation((method, params) =>
      method === "sessions.create"
        ? (async () => {
            relaunching.resolve();
            await released.promise;
            return answer(method, params);
          })()
        : answer(method, params),
    );

    const resuming = ticket.handoffs.resume(ticket.warn);
    await relaunching.promise;
    expect(cardRunId((await store.get(card.id))!)).toMatch(new RegExp(`^workboard:${card.id}:`));
    const now = Date.now() + 1000;
    await syncWorkboardAgentEnded({
      store,
      event: {
        runId: "earlier-turn",
        success: true,
        durationMs: 60_000,
        messages: [{ role: "assistant", content: "That settles it." }],
      },
      context: { runId: "earlier-turn", sessionKey: ticket.sessionKey },
      now,
      readSessions: endedSession(),
    });
    released.resolve();
    await resuming;

    expect(ticket.warn).not.toHaveBeenCalled();
    const relaunched = await store.get(card.id);
    expect(relaunched?.status).toBe("running");
    expect(cardRunId(relaunched!), "the earlier run is not linked to the round").toMatch(
      new RegExp(`^workboard:${card.id}:`),
    );
  });

  it("names the grilling result when its start waits or fails", async () => {
    const waiting = await grillingTicket();
    waiting.store.nodeTicketConcurrency = 1;
    await startNodeCard(waiting.store, waiting.gateway);
    await waiting.end();
    await waiting.handoffs.resume(waiting.warn);
    expect((await waiting.store.get(waiting.card.id))?.metadata?.comments?.at(-1)?.body).toMatch(
      /^The grilling result waits for a node-ticket slot;/,
    );

    const failing = await grillingTicket();
    await failing.end();
    await createNodeTicketHandoffs({
      store: failing.store,
      runtime: failing.gateway,
      github: { token: () => undefined },
      start: async () => ({ startFailures: [{ error: "node offline" }] }),
    }).resume(failing.warn);
    const blocked = await failing.store.get(failing.card.id);
    expect(blocked?.status).toBe("blocked");
    expect(blocked?.metadata?.comments?.at(-1)?.body).toContain(
      "The grilling result could not start: node offline",
    );
  });

  it("clears the pending end when the resumed round's done report is refused for its proof", async () => {
    const ticket = await grillingTicket();
    await ticket.end();
    await ticket.handoffs.resume(ticket.warn);
    const ended = await ticket.log();

    await endTurn(
      ticket.store,
      ticket.card.id,
      reportMessages({
        outcome: "done",
        headline: "Empty input returns [].",
        summary: "Parser returns [].",
        proof: [{ command: "pytest", status: "failed" }],
      }),
    );

    const blocked = await ticket.store.get(ticket.card.id);
    expect(blocked?.status).toBe("blocked");
    expect(worktreeOf(blocked)?.grill).toEqual({
      status: "closed",
      rounds: 1,
      attachmentId: expect.any(String),
      sessionKey: await ticket.grillSessionKey(),
    });
    expect(await ticket.log()).toBe(ended);
  });

  it("does not present an earlier result when the full log dropped the latest end", async () => {
    const ticket = await grillingTicket();
    const { store, card } = ticket;
    await ticket.grillDone(await ticket.grillSessionKey(), { handoff: "Old result." });
    await ticket.handoffs.resume(ticket.warn);
    await endTurn(
      store,
      card.id,
      reportMessages({ outcome: "grill", summary: "h".repeat(300_000) }),
    );
    await ticket.handoffs.resume(ticket.warn);

    expect((await ticket.end())[0]).toBe(true);
    await ticket.handoffs.resume(ticket.warn);

    expect(ticket.grillCreates()).toHaveLength(2);
    expect(ticket.grillCreates().at(-1)?.[1]?.key).toBe(`agent:dev:grill-${card.id.slice(0, 8)}-2`);
    expect(ticket.brief()).toContain("The result could not be read from the grilling log.");
    expect(ticket.brief()).not.toContain("Old result.");
  });
});

describe("grilling log ownership", () => {
  it("keeps the log through the metadata budget and the attachment cap", async () => {
    const ticket = await grillingTicket();
    const { store, card } = ticket;
    const logId = worktreeOf(await store.get(card.id))?.grill?.attachmentId;
    const attachmentIds = async () =>
      (await store.get(card.id))?.metadata?.attachments?.map((entry) => entry.id);
    for (let index = 0; index < 20; index += 1) {
      await store.addAttachment(card.id, {
        fileName: `note-${index}.txt`,
        mimeType: "text/plain",
        contentBase64: Buffer.from(`note ${index}`).toString("base64"),
      });
    }
    expect(await attachmentIds()).toHaveLength(20);
    expect(await attachmentIds()).toContain(logId);

    for (let index = 0; index < 14; index += 1) {
      await store.addComment(card.id, { body: `${index} ${"x".repeat(1900)}` });
    }
    await ticket.grillDone(await ticket.grillSessionKey(), { handoff: RESULT });
    expect(await attachmentIds()).toContain(logId);
    expect(await ticket.log()).toMatch(/^## Handoff 1\n/);
  });

  it("keeps a result the grill session hands back while another writer changed the card", async () => {
    let interfere = false;
    const harness = createWorkboardSqliteTestHarness({
      beforeCardWrite: async (key) => {
        if (!interfere) {
          return;
        }
        interfere = false;
        const entry = (await harness.stores.cards.lookup(key))!;
        await harness.stores.cards.register(key, {
          ...entry,
          card: {
            ...entry.card,
            title: "Renamed on another Gateway",
            updatedAt: entry.card.updatedAt + 1,
          },
        });
      },
    });
    const ticket = await grillingTicket(harness.store);

    interfere = true;
    await ticket.grillDone(await ticket.grillSessionKey(), { handoff: RESULT });

    const card = await ticket.store.get(ticket.card.id);
    expect(card?.title).toBe("Renamed on another Gateway");
    expect(card?.status).toBe("todo");
    expect(await ticket.log()).toContain(RESULT);
    expect(card?.metadata?.attachments?.[0]?.byteSize).toBe(
      Buffer.byteLength((await ticket.log())!),
    );
  });

  it("refuses to delete the grilling log", async () => {
    const ticket = await grillingTicket();
    const capture = createGatewayMethodCapture();
    registerWorkboardGatewayMethods({ api: capture.api, store: ticket.store });
    const attachmentId = worktreeOf(await ticket.store.get(ticket.card.id))?.grill?.attachmentId;

    const respond = await capture.invoke("workboard.cards.attachments.delete", {
      id: ticket.card.id,
      attachmentId,
    });

    expect(respond.mock.calls[0]?.[2]?.message).toContain(
      "grilling.md is this card's grilling log and cannot be deleted",
    );
    expect(await ticket.log()).toMatch(/^## Handoff 1\n/);
  });

  it("cuts an entry that would pass the size limit and says so, then stays as it is", () => {
    const full = appendGrillLog("## Handoff 1\n", "é".repeat(400), 300);

    expect(Buffer.byteLength(full)).toBeLessThanOrEqual(300);
    expect(full).toMatch(/^## Handoff 1\n\né+\n\n\(The grilling log reached its size limit/);
    expect(appendGrillLog(full, "## Handoff 2", 300)).toBe(full);
  });
});
