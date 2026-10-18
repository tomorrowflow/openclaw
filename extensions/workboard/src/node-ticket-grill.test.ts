// Workboard tests cover a node ticket grilling the operator one question per round.
import type { WorkboardCard } from "@openclaw/workboard-contract";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createWorkboardAutomationNudgeService } from "./automation-nudge.js";
import { redactOperatorCard } from "./card-redaction.js";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import { registerWorkboardGatewayMethods } from "./gateway.js";
import { syncWorkboardAgentEnded } from "./lifecycle-sync.js";
import { nudgeContext } from "./lifecycle-sync.test-support.js";
import { appendGrillLog } from "./node-ticket-grill.js";
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

async function grillingTicket() {
  const store = createWorkboardSqliteTestStore();
  const gateway = createNodeGateway();
  const { card, sessionKey } = await startNodeCard(store, gateway);
  await endTurn(store, card.id, grillReport);
  const capture = createGatewayMethodCapture();
  registerWorkboardGatewayMethods({ api: capture.api, store });
  const answer = async (value: unknown) => {
    const respond = await capture.invoke("workboard.cards.grill.answer", {
      id: card.id,
      answer: value,
    });
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
  return { store, gateway, card, sessionKey, answer, handoffs, warn, log, launches, brief };
}

const worktreeOf = (card: WorkboardCard | undefined) =>
  card?.metadata?.automation?.target?.worktree;

describe("node ticket grilling", () => {
  it("waits on the operator, then resumes the same session with the answer and closes on done", async () => {
    const ticket = await grillingTicket();
    const { store, card } = ticket;
    expect(ticket.launches()[0]?.[1]?.message).toContain("Use `grill` when the ticket needs");

    const asked = await store.get(card.id);
    expect(asked?.status).toBe("review");
    expect(asked?.metadata?.claim).toBeUndefined();
    const worktree = asked?.metadata?.automation?.target?.worktree;
    expect(worktree?.handoff).toMatchObject({ phase: "grilling" });
    expect(worktree?.grill).toMatchObject({ status: "open", rounds: 1 });
    expect(asked?.metadata?.attachments).toEqual([
      expect.objectContaining({
        id: worktree?.grill?.attachmentId,
        fileName: "grilling.md",
        mimeType: "text/markdown",
      }),
    ]);
    expect(asked?.metadata?.comments?.at(-1)?.body).toBe(
      "**Grilling question 1:** Should the parser accept empty input?\n\nAnswer it in the card's Grilling tab; the same session continues with your answer.",
    );
    expect(redactOperatorCard(asked!)).toMatchObject({
      stage: { kind: "grilling", round: 1 },
      grill: { status: "open", rounds: 1, attachmentId: worktree?.grill?.attachmentId },
    });
    expect(await ticket.log()).toBe(
      `## Question 1\n\n**Settled so far:** Scope is the parser only.\n\n${QUESTION}\n`,
    );

    const [ok, result] = await ticket.answer("Yes, return [].");
    expect(ok).toBe(true);
    expect(result).toMatchObject({ card: { status: "todo" } });
    const answered = await store.get(card.id);
    expect(answered?.metadata?.automation?.target?.worktree?.grill?.pendingAnswer).toEqual({
      answeredAt: expect.any(Number),
    });
    expect(JSON.stringify(answered?.metadata)).not.toContain("Yes, return [].");
    expect(await ticket.log()).toMatch(/\n\*\*Answer\*\* \(\d{4}-.+\)\n\nYes, return \[\]\.\n$/);
    const answeredLog = await ticket.log();
    expect(answered?.metadata?.attachments?.[0]?.byteSize).toBe(Buffer.byteLength(answeredLog!));

    await ticket.handoffs.resume(ticket.warn);

    expect(ticket.warn).not.toHaveBeenCalled();
    const resumed = await store.get(card.id);
    expect(resumed?.status).toBe("running");
    expect(resumed?.metadata?.automation?.target?.worktree?.feedback).toMatchObject({
      kind: "grill",
    });
    const launch = ticket.launches().at(-1)?.[1];
    expect(launch).toMatchObject({ key: ticket.sessionKey });
    const brief = String(launch?.message).split("## Turn contract")[0];
    expect(brief).toContain("## Grilling answer");
    expect(brief).toContain("Yes, return [].");
    expect(brief).not.toContain("Grilling question 1");
    expect(brief).not.toContain("## Answers to your questions");

    await endTurn(
      store,
      card.id,
      reportMessages({
        outcome: "done",
        headline: "Empty input returns [].",
        summary: "Parser returns [] for empty input.",
        proof: [{ command: "pytest", status: "passed" }],
      }),
    );

    const done = await store.get(card.id);
    expect(done?.metadata?.automation?.target?.worktree).toMatchObject({
      handoff: { phase: "pending" },
      grill: { status: "closed", rounds: 1 },
    });
    expect(done?.metadata?.automation?.target?.worktree?.grill?.pendingAnswer).toBeUndefined();
    expect(await ticket.log()).toBe(
      `${answeredLog}\n## Outcome\n\n**done:** Empty input returns [].\n`,
    );
  });

  it("refuses an answer the card is not waiting on, an empty one, and one over the cap", async () => {
    const ticket = await grillingTicket();

    expect((await ticket.answer("  "))[2]?.message).toContain("answer is required.");
    expect((await ticket.answer("x".repeat(4001)))[2]?.message).toContain(
      "answer must be 4000 characters or fewer",
    );
    expect((await ticket.answer("Yes."))[0]).toBe(true);
    expect((await ticket.answer("Also no."))[2]?.message).toContain(
      "This card is not waiting on a grilling answer",
    );
    expect(await ticket.log()).not.toContain("Also no.");
  });

  it("bounces a move to todo without an answer back to review once", async () => {
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
      "Moved to todo without an answer; answer the grilling question in the card's Grilling tab to resume the session.",
    ]);
    expect(ticket.launches()).toHaveLength(1);
  });

  it("keeps the answer in the brief when the resumed launch fails and is retried", async () => {
    const ticket = await grillingTicket();
    await ticket.answer("Yes, return [].");
    const respond = ticket.gateway.respond.getMockImplementation();
    ticket.gateway.respond.mockImplementation((method, params) => {
      if (method === "sessions.create") {
        ticket.gateway.respond.mockImplementation(respond!);
        throw new Error("node went offline");
      }
      return respond!(method, params);
    });
    await ticket.handoffs.resume(ticket.warn);
    expect((await ticket.store.get(ticket.card.id))?.status).toBe("blocked");

    await ticket.store.unblock(ticket.card.id);
    await dispatchAndStartWorkboardCards({
      store: ticket.store,
      subagent: { run: vi.fn() },
      nodeTickets: ticket.gateway,
      options: { cardId: ticket.card.id },
    });

    const brief = String(ticket.launches().at(-1)?.[1]?.message).split("## Turn contract")[0];
    expect(brief).toContain(
      "## Grilling answer\nThe operator answered your grilling question:\n\nYes, return [].",
    );
  });

  it("keeps the worktree of an answered ticket whose start claimed it before the swap", async () => {
    const ticket = await grillingTicket();
    await ticket.answer("Yes.");
    await ticket.store.claim(ticket.card.id, { ownerId: "dispatcher" });

    await ticket.handoffs.resume(ticket.warn);

    const stored = await ticket.store.get(ticket.card.id);
    expect(stored?.status).toBe("running");
    expect(stored?.metadata?.automation?.target?.worktree?.handoff).toMatchObject({
      phase: "grilling",
    });
    expect(ticket.gateway.respond).not.toHaveBeenCalledWith(
      "node.invoke",
      expect.objectContaining({
        params: expect.objectContaining({ command: expect.arrayContaining(["bundle"]) }),
      }),
    );
  });

  it("asks the next question in the same log and clears the consumed answer", async () => {
    const ticket = await grillingTicket();
    await ticket.answer("Yes.");
    await ticket.handoffs.resume(ticket.warn);

    await endTurn(
      ticket.store,
      ticket.card.id,
      reportMessages({ outcome: "grill", question: "Raise on None?" }),
    );

    const asked = await ticket.store.get(ticket.card.id);
    expect(asked?.status).toBe("review");
    expect(asked?.metadata?.automation?.target?.worktree?.grill).toEqual({
      status: "open",
      rounds: 2,
      attachmentId: expect.any(String),
    });
    expect(asked?.metadata?.attachments).toHaveLength(1);
    expect(await ticket.log()).toMatch(/Yes\.\n\n## Question 2\n\nRaise on None\?\n$/);
  });

  it("wakes the board automation for a questions round but not for a grilling round", async () => {
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

      await end(grillReport);
      expect(request).not.toHaveBeenCalled();
      await end(reportMessages({ outcome: "needs_input", summary: "Two fit", questions: ["Q1"] }));
      expect(request).toHaveBeenCalledOnce();
    } finally {
      service.stop();
    }
  });
});

describe("grilling log ownership", () => {
  it("keeps the log through the metadata budget and the attachment cap, and the brief reads the answer from it", async () => {
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
    const answer = `Yes. ${"y".repeat(3990)}`;
    expect((await ticket.answer(answer))[0]).toBe(true);
    expect(await attachmentIds()).toContain(logId);
    expect(await ticket.log()).toMatch(/^## Question 1\n/);

    await ticket.handoffs.resume(ticket.warn);
    expect(ticket.brief()).toContain(
      `The operator answered your grilling question:\n\n${answer}\n`,
    );
  });

  it("says plainly in the brief when the answer cannot be read from the log", async () => {
    const ticket = await grillingTicket();
    await ticket.answer("Yes, return [].");
    vi.spyOn(ticket.store, "readNodeGrillLog").mockResolvedValue(undefined);

    await ticket.handoffs.resume(ticket.warn);

    expect(ticket.brief()).toContain(
      "## Grilling answer\nThe operator answered your grilling question, but the answer could not be read from the card's grilling log (`grilling.md`). Ask the question again with a `grill` report.",
    );
  });

  it("refuses an answer the full log has no room for", async () => {
    const ticket = await grillingTicket();
    await ticket.answer("Yes.");
    await ticket.handoffs.resume(ticket.warn);
    await endTurn(
      ticket.store,
      ticket.card.id,
      reportMessages({ outcome: "grill", question: "q".repeat(300_000) }),
    );

    expect((await ticket.answer("No."))[2]?.message).toContain("The grilling log is full");
    expect(
      worktreeOf(await ticket.store.get(ticket.card.id))?.grill?.pendingAnswer,
    ).toBeUndefined();
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
  it("ends the grilling when the operator moves the card to done, and a comment resumes it", async () => {
    const ticket = await grillingTicket();
    const { store, card } = ticket;

    await store.move(card.id, "done", undefined);
    await ticket.handoffs.resume(ticket.warn);

    const ended = await store.get(card.id);
    expect(ended?.status).toBe("review");
    expect(worktreeOf(ended)).toMatchObject({
      handoff: { phase: "questions", escalatedAt: expect.any(Number) },
      grill: { status: "closed", rounds: 1 },
    });
    expect(ended?.metadata?.comments?.at(-1)?.body).toMatch(
      /^Moving this ticket to done ended its grilling, and there is nothing to publish yet\./,
    );
    expect(await ticket.log()).toMatch(
      /\n## Outcome\n\n\*\*ended by the operator:\*\* The card was moved to done while it waited on a grilling answer\.\n$/,
    );

    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 1000 });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    await store.addComment(card.id, { body: "Build the parser only." }, undefined, "operator");
    await store.move(card.id, "todo", undefined);
    await ticket.handoffs.resume(ticket.warn);

    expect((await store.get(card.id))?.status).toBe("running");
    expect(ticket.brief()).toContain("## Answers to your questions");
    expect(ticket.brief()).toContain("Build the parser only.");
  });

  it("closes the grilling blocked when its done report has no passing proof", async () => {
    const ticket = await grillingTicket();
    await ticket.answer("Yes.");
    await ticket.handoffs.resume(ticket.warn);

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
    expect(worktreeOf(blocked)?.grill?.status).toBe("closed");
    expect(await ticket.log()).toMatch(
      /\n## Outcome\n\n\*\*blocked:\*\* Reported done without passing proof: Parser returns \[\]\.\n$/,
    );
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
