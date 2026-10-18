// Workboard tests cover a node ticket grilling the operator live in its session chat.
import type { WorkboardCard } from "@openclaw/workboard-contract";
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
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

function reportMessages(report: Record<string, unknown>) {
  return [
    {
      role: "assistant",
      content: `Asking.\n\n\`\`\`workboard-report\n${JSON.stringify(report)}\n\`\`\``,
    },
  ];
}

const QUESTION =
  "Should the parser accept empty input?\n\nRecommended: yes, return `[]` so the CLI treats it as a no-op.";

const grillReport = reportMessages({
  outcome: "grill",
  question: QUESTION,
  summary: "Scope is the parser only.",
});

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

/** A chat turn the operator sent in the card's session, started `startedAgoMs` before it ended. */
async function chatTurn(
  store: WorkboardStore,
  cardId: string,
  reply: string,
  options: {
    prompt?: string;
    startedAgoMs?: number;
    onMatched?: Parameters<typeof syncWorkboardAgentEnded>[0]["onMatched"];
  } = {},
) {
  const card = await store.get(cardId);
  const now = Date.now() + 1000;
  await syncWorkboardAgentEnded({
    store,
    event: {
      runId: `chat-${now}`,
      success: true,
      durationMs: options.startedAgoMs ?? 500,
      messages: [
        { role: "user", content: "Earlier round prompt" },
        { role: "assistant", content: "Earlier round reply" },
        { role: "user", content: options.prompt ?? "Yes, return []." },
        { role: "assistant", content: reply },
      ],
    },
    context: { runId: `chat-${now}`, sessionKey: card ? cardSessionKey(card) : undefined },
    now,
    readSessions: endedSession(),
    ...(options.onMatched ? { onMatched: options.onMatched } : {}),
  });
}

const reportBlock = (report: Record<string, unknown>) =>
  `\n\n\`\`\`workboard-report\n${JSON.stringify(report)}\n\`\`\``;

async function grillingTicket() {
  const store = createWorkboardSqliteTestStore();
  const gateway = createNodeGateway();
  const { card, sessionKey } = await startNodeCard(store, gateway);
  await endTurn(store, card.id, grillReport);
  const capture = createGatewayMethodCapture();
  registerWorkboardGatewayMethods({ api: capture.api, store });
  const end = async () => {
    const respond = await capture.invoke("workboard.cards.grill.end", { id: card.id });
    return respond.mock.calls[0] as [boolean, unknown, { message?: string }?];
  };
  const warn = vi.fn();
  const handoffs = createNodeTicketHandoffs({
    store,
    runtime: gateway,
    github: { token: () => undefined },
    start: async (cardId, queue) =>
      await dispatchAndStartWorkboardCards({
        store,
        subagent: { run: vi.fn() },
        nodeTickets: gateway,
        options: { cardId, queue },
      }),
  });
  const log = async () => {
    const attachmentId = (await store.get(card.id))?.metadata?.automation?.target?.worktree?.grill
      ?.attachmentId;
    const stored = attachmentId ? await store.getAttachment(attachmentId) : undefined;
    return stored ? Buffer.from(stored.contentBase64, "base64").toString("utf8") : undefined;
  };
  const launches = () =>
    gateway.respond.mock.calls.filter(([method]) => method === "sessions.create");
  const brief = () => String(launches().at(-1)?.[1]?.message).split("## Turn contract")[0];
  const chat = async (reply: string, options?: Parameters<typeof chatTurn>[3]) =>
    await chatTurn(store, card.id, reply, options);
  return { store, gateway, card, sessionKey, chat, end, handoffs, warn, log, launches, brief };
}

const worktreeOf = (card: WorkboardCard | undefined) =>
  card?.metadata?.automation?.target?.worktree;

// Log entries carry ISO times; the tests compare the log with them as <t>.
const untimed = (log: string | undefined) => log?.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "<t>");
const QUESTION_LOG = `## Question 1\n\n**Settled so far:** Scope is the parser only.\n\n${QUESTION}\n`;

describe("node ticket grilling", () => {
  it("waits in review while the operator chats with the session, logging each turn", async () => {
    const ticket = await grillingTicket();
    const { store, card } = ticket;
    expect(ticket.launches()[0]?.[1]?.message).toContain("Use `grill` to start a live grilling");

    const asked = await store.get(card.id);
    expect(asked?.status).toBe("review");
    expect(asked?.metadata?.claim).toBeUndefined();
    const worktree = worktreeOf(asked);
    expect(worktree?.handoff).toMatchObject({ phase: "grilling" });
    expect(worktree?.grill).toMatchObject({ status: "open", rounds: 1 });
    expect(asked?.metadata?.attachments).toEqual([
      expect.objectContaining({
        id: worktree?.grill?.attachmentId,
        fileName: GRILL_LOG_FILE_NAME,
        mimeType: "text/markdown",
      }),
    ]);
    expect(asked?.metadata?.comments?.at(-1)?.body).toBe(
      "**Grilling question 1:** Should the parser accept empty input?\n\nAnswer it in the card's session chat; the grilling continues there until it ends.",
    );
    expect(redactOperatorCard(asked!)).toMatchObject({
      stage: { kind: "grilling", round: 1 },
      grill: { status: "open", rounds: 1, attachmentId: worktree?.grill?.attachmentId },
    });
    expect(await ticket.log()).toBe(QUESTION_LOG);
    const comments = asked?.metadata?.comments?.length;

    await ticket.chat("Good. Should `None` raise?\n\nRecommended: raise `TypeError`.");

    const chatted = await store.get(card.id);
    expect(chatted?.status).toBe("review");
    expect(worktreeOf(chatted)?.handoff).toEqual(worktree?.handoff);
    expect(worktreeOf(chatted)?.grill).toEqual(worktree?.grill);
    expect(chatted?.metadata?.comments).toHaveLength(comments!);
    expect(untimed(await ticket.log())).toBe(
      `${QUESTION_LOG}\n**Operator** (<t>)\n\nYes, return [].\n\n**Agent** (<t>)\n\nGood. Should \`None\` raise?\n\nRecommended: raise \`TypeError\`.\n`,
    );
    expect(chatted?.metadata?.attachments?.[0]?.byteSize).toBe(
      Buffer.byteLength((await ticket.log())!),
    );

    await ticket.chat(
      `Next one.${reportBlock({ outcome: "grill", question: "Accept tabs?", summary: "Empty input returns []." })}`,
      { prompt: "Raise." },
    );

    const next = await store.get(card.id);
    expect(next?.status).toBe("review");
    expect(worktreeOf(next)?.grill).toMatchObject({ status: "open", rounds: 2 });
    expect(next?.metadata?.comments).toHaveLength(comments!);
    expect(untimed(await ticket.log())).toMatch(
      /\n\*\*Operator\*\* \(<t>\)\n\nRaise\.\n\n\*\*Agent\*\* \(<t>\)\n\nNext one\.\n\n## Question 2\n\n\*\*Settled so far:\*\* Empty input returns \[\]\.\n\nAccept tabs\?\n$/,
    );
    expect(ticket.launches()).toHaveLength(1);
  });

  it("ignores a turn that started before the question and turns on a card that is not grilling", async () => {
    const ticket = await grillingTicket();
    await ticket.chat("Old reply.", { startedAgoMs: 60_000 });
    expect(await ticket.log()).toBe(QUESTION_LOG);

    expect((await ticket.end())[0]).toBe(true);
    const ended = await ticket.log();
    await ticket.chat(`Late.${reportBlock({ outcome: "grill_done", summary: "Late." })}`);

    expect(await ticket.log()).toBe(ended);
    expect((await ticket.store.get(ticket.card.id))?.status).toBe("todo");
  });

  it("ends the grilling on a grill_done reply and resumes the same session with the summary", async () => {
    const ticket = await grillingTicket();
    const { store, card } = ticket;

    await ticket.chat(
      `Agreed.${reportBlock({ outcome: "grill_done", summary: "Parser only; empty input returns []." })}`,
    );

    const ended = await store.get(card.id);
    expect(ended?.status).toBe("todo");
    expect(worktreeOf(ended)?.grill).toEqual({
      status: "closed",
      rounds: 1,
      attachmentId: expect.any(String),
      pending: { kind: "end", at: expect.any(Number) },
    });
    expect(untimed(await ticket.log())).toMatch(
      /\n\*\*Agent\*\* \(<t>\)\n\nAgreed\.\n\n## Outcome\n\n\*\*settled in the session chat\*\* \(<t>\): Parser only; empty input returns \[\]\.\n$/,
    );

    await ticket.handoffs.resume(ticket.warn);

    expect(ticket.warn).not.toHaveBeenCalled();
    expect((await store.get(card.id))?.status).toBe("running");
    expect(ticket.launches()).toHaveLength(2);
    expect(ticket.launches().at(-1)?.[1]).toMatchObject({ key: ticket.sessionKey });
    expect(ticket.brief()).toContain(
      "## Grilling ended\nThe grilling ended. What you settled together is in this session and in the card's grilling log (`grilling.md`).\n\nClosing note:\n\nParser only; empty input returns [].\n\nNow carry out the ticket with that result and end with `done`, `blocked`, or `needs_input`.",
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

  it("ends the grilling on any other report in a chat turn without importing it", async () => {
    for (const report of [
      {
        outcome: "done",
        headline: "Did it.",
        summary: "Changed the parser.",
        proof: [{ command: "pytest", status: "passed" }],
      },
      { outcome: "needs_input", summary: "Which file?", questions: ["Q1"] },
    ]) {
      const ticket = await grillingTicket();
      await ticket.chat(`Here.${reportBlock(report)}`);

      const ended = await ticket.store.get(ticket.card.id);
      expect(ended?.status, report.outcome).toBe("todo");
      expect(worktreeOf(ended)?.handoff, report.outcome).toMatchObject({ phase: "grilling" });
      expect(worktreeOf(ended)?.grill?.pending, report.outcome).toMatchObject({ kind: "end" });
      expect(ended?.metadata?.proof ?? [], report.outcome).toEqual([]);
      expect(await ticket.log()).toContain(
        `**ended by a ${report.outcome} reply in the session chat** (`,
      );
    }
  });

  it("blocks a grill_done report that ends a claimed round", async () => {
    const store = createWorkboardSqliteTestStore();
    const { card } = await startNodeCard(store, createNodeGateway());

    await endTurn(store, card.id, reportMessages({ outcome: "grill_done", summary: "Settled." }));

    const blocked = await store.get(card.id);
    expect(blocked?.status).toBe("blocked");
    expect(blocked?.metadata?.comments?.at(-1)?.body).toContain(
      "Reported grill_done, but no grilling was live in the session chat: Settled.",
    );
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
      "Moved to todo while grilling; keep answering in the card's session chat, or choose End grilling on the card to let the agent continue with what is settled.",
    ]);
    expect(ticket.launches()).toHaveLength(1);
  });

  it("wakes the board automation for a questions round but not for a grilling round or its chat", async () => {
    const store = createWorkboardSqliteTestStore();
    await store.upsertBoard({ id: "default", automationJobId: "job-review" });
    const request = vi.fn().mockResolvedValue({ ok: true, ran: true });
    const service = createWorkboardAutomationNudgeService({ store });
    await service.start(nudgeContext(request));
    try {
      const end = async (messages: unknown[]) => {
        const { card, sessionKey, runId } = await startNodeCard(store);
        await syncWorkboardAgentEnded({
          store,
          event: { runId, success: true, messages },
          context: { runId, sessionKey },
          readSessions: endedSession(),
          onMatched: service.nudge,
        });
        return card.id;
      };

      const grilling = await end(grillReport);
      await chatTurn(store, grilling, "Next?", { onMatched: service.nudge });
      expect(request).not.toHaveBeenCalled();
      await end(reportMessages({ outcome: "needs_input", summary: "Two fit", questions: ["Q1"] }));
      expect(request).toHaveBeenCalledOnce();
    } finally {
      service.stop();
    }
  });
});

describe("grilling log ownership", () => {
  it("keeps the log through the metadata budget and the attachment cap, and cuts a long chat message", async () => {
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
    await ticket.chat(`Long. ${"y".repeat(9000)}`);
    expect(await attachmentIds()).toContain(logId);
    const log = await ticket.log();
    expect(log).toMatch(/^## Question 1\n/);
    expect(log).toContain(
      `Long. ${"y".repeat(7994)}… (cut; the full message is in the session chat)\n`,
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
    expect(await ticket.log()).toMatch(/^## Question 1\n/);
  });
});

describe("grilling endings", () => {
  it("ends the grilling from the card and resumes the same session to carry out the ticket", async () => {
    const ticket = await grillingTicket();
    const { store, card } = ticket;

    const [ok, result] = await ticket.end();
    expect(ok).toBe(true);
    expect(result).toMatchObject({ card: { status: "todo" } });
    expect(worktreeOf(await store.get(card.id))?.grill).toEqual({
      status: "closed",
      rounds: 1,
      attachmentId: expect.any(String),
      pending: { kind: "end", at: expect.any(Number) },
    });
    expect(untimed(await ticket.log())).toMatch(
      /\n## Outcome\n\n\*\*ended by the operator\*\* \(<t>\): no note\n$/,
    );
    expect((await ticket.end())[2]?.message).toContain("This card is not grilling");

    await ticket.handoffs.resume(ticket.warn);

    expect(ticket.warn).not.toHaveBeenCalled();
    expect((await store.get(card.id))?.status).toBe("running");
    expect(ticket.launches().at(-1)?.[1]).toMatchObject({ key: ticket.sessionKey });
    expect(ticket.brief()).toContain("## Grilling ended\n");
    expect(ticket.brief()).not.toContain("Closing note");
  });

  it("ends the grilling when the operator moves the card to done", async () => {
    const ticket = await grillingTicket();
    const { store, card } = ticket;

    await store.move(card.id, "done", undefined);
    await ticket.handoffs.resume(ticket.warn);

    expect(ticket.warn).not.toHaveBeenCalled();
    const resumed = await store.get(card.id);
    expect(resumed?.status, "the same pass resumes the session").toBe("running");
    expect(worktreeOf(resumed)?.grill).toMatchObject({
      status: "closed",
      pending: { kind: "end" },
    });
    expect(untimed(await ticket.log())).toMatch(
      /\n## Outcome\n\n\*\*ended by the operator\*\* \(<t>\): no note\n$/,
    );
    expect(ticket.launches().at(-1)?.[1]).toMatchObject({ key: ticket.sessionKey });
    expect(ticket.brief()).toContain("## Grilling ended\n");
  });

  it("resumes a grilling settled in chat that the operator moved to done before it started", async () => {
    const ticket = await grillingTicket();
    const { store, card } = ticket;
    await ticket.chat(`Done.${reportBlock({ outcome: "grill_done", summary: "Parser only." })}`);

    await store.move(card.id, "done", undefined);
    await ticket.handoffs.resume(ticket.warn);

    expect(ticket.warn).not.toHaveBeenCalled();
    expect((await store.get(card.id))?.status).toBe("running");
    expect(ticket.launches().at(-1)?.[1]).toMatchObject({ key: ticket.sessionKey });
    expect(ticket.brief()).toContain("Closing note:\n\nParser only.\n");
  });

  it("does not present an earlier closing note when the full log dropped the latest end", async () => {
    const ticket = await grillingTicket();
    const { store, card } = ticket;
    await ticket.chat(`Ok.${reportBlock({ outcome: "grill_done", summary: "Old note." })}`);
    await ticket.handoffs.resume(ticket.warn);
    await endTurn(
      store,
      card.id,
      reportMessages({ outcome: "grill", question: "q".repeat(300_000) }),
    );

    expect((await ticket.end())[0]).toBe(true);
    await ticket.handoffs.resume(ticket.warn);

    expect(ticket.brief()).toContain(
      "If the grilling ended with a closing note, it could not be read from the grilling log.",
    );
    expect(ticket.brief()).not.toContain("Old note.");
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
    });
    expect(await ticket.log()).toBe(ended);
  });

  it("blocks a grill report whose question could not be recorded", async () => {
    const store = createWorkboardSqliteTestStore();
    const { card } = await startNodeCard(store, createNodeGateway());
    vi.spyOn(store, "recordNodeGrillQuestion").mockResolvedValue(undefined);

    await endTurn(store, card.id, grillReport);

    const blocked = await store.get(card.id);
    expect(blocked?.status).toBe("blocked");
    expect(blocked?.metadata?.claim).toBeUndefined();
    expect(blocked?.metadata?.comments?.at(-1)?.body).toContain(
      "Asked a grilling question, but the card's node worktree changed before it could be recorded",
    );
  });
});

describe("grilling log", () => {
  it("cuts an entry that would pass the size limit and says so, then stays as it is", () => {
    const full = appendGrillLog("## Question 1\n", "é".repeat(400), 300);

    expect(Buffer.byteLength(full)).toBeLessThanOrEqual(300);
    expect(full).toMatch(/^## Question 1\n\né+\n\n\(The grilling log reached its size limit/);
    expect(appendGrillLog(full, "## Question 2", 300)).toBe(full);
  });
});
