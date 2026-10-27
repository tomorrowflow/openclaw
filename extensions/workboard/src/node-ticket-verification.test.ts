// Workboard tests cover the independent verification of a node ticket's imported round.
import { existsSync } from "node:fs";
import path from "node:path";
import type { WorkboardCard } from "@openclaw/workboard-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkboardLifecycleSessionReader } from "./lifecycle-sync.js";
import {
  finishNodeTicket,
  git,
  moveDoneAfterReviewDeadline,
  removeTempRoots,
  startNodeCard,
} from "./node-ticket.test-support.js";
import { workboardCardConsumesNodeTicketSlot } from "./store-constants.js";

afterEach(() => {
  removeTempRoots();
});

const VERIFIER = { agentId: "verifier", model: "openai/gpt-6-sol" };

function verificationReply(block: unknown) {
  return [
    { role: "user", content: "Verify this" },
    {
      role: "assistant",
      content: `Ran it.\n\n\`\`\`workboard-verification\n${typeof block === "string" ? block : JSON.stringify(block)}\n\`\`\``,
    },
  ];
}

/**
 * A finished node ticket on a board with a verifier. The fake Gateway records
 * the verifier session's create, answers `chat.history` with `history`, and
 * the session owner's view says whether that session still runs.
 */
async function verifiedTicket(params: { notes?: string; failCreate?: string } = {}) {
  const onReview = vi.fn(async (_card: WorkboardCard) => {});
  const verifier = { running: false, history: [] as unknown[], creates: [] as unknown[] };
  const readSessions: WorkboardLifecycleSessionReader = async (options) => {
    const key = options.sessionKey;
    const created = key !== undefined && verifier.creates.length > 0 && key.includes(":verify-");
    return {
      sessions: created
        ? [{ key, hasActiveRun: verifier.running, updatedAt: Date.now() }]
        : key
          ? [{ key, hasActiveRun: false, status: "done" as const, updatedAt: Date.now() }]
          : [],
      complete: true,
    };
  };
  const ticket = await finishNodeTicket({ onReview, readSessions });
  await ticket.store.upsertBoard({ id: "default", orchestration: { verifier: VERIFIER } });
  if (params.notes) {
    await ticket.store.update(ticket.card.id, { notes: params.notes });
  }
  const answer = ticket.gateway.respond.getMockImplementation()!;
  ticket.gateway.respond.mockImplementation((method, requestParams) => {
    if (method === "chat.history") {
      return { messages: verifier.history };
    }
    if (method === "sessions.create" && String(requestParams?.key).includes(":verify-")) {
      verifier.creates.push(requestParams);
      verifier.running = !params.failCreate;
      return params.failCreate
        ? {
            ok: true,
            key: requestParams?.key,
            runStarted: false,
            runError: { message: params.failCreate },
          }
        : {
            ok: true,
            key: requestParams?.key,
            runId: "run-verify",
            runStarted: true,
            resolved: { modelProvider: "openai", model: "gpt-6-sol" },
          };
    }
    return answer(method, requestParams);
  });
  const verificationOf = async () =>
    (await ticket.store.get(ticket.card.id))?.metadata?.automation?.target?.worktree?.verification;
  return { ...ticket, onReview, verifier, verificationOf };
}

describe("node ticket verification", () => {
  it("verifies an imported round on the node before waking the board automation, then settles it", async () => {
    const notes = "Spec: empty input returns [].\n\nProof: `pytest tests/test_parser.py`.";
    const ticket = await verifiedTicket({ notes });
    const { store, card, repos, handoffs, warn, onReview, verifier } = ticket;
    const head = git(ticket.worktree, "rev-parse", "HEAD");
    const base = git(repos.target.repoPath, "rev-parse", "main");
    const verifyPath = path.join(repos.target.worktreesRoot, `verify-${card.id.slice(0, 8)}-r0`);

    await handoffs.resume(warn);

    expect(warn).not.toHaveBeenCalled();
    expect(onReview).not.toHaveBeenCalled();
    expect((await store.get(card.id))?.status).toBe("review");
    expect(
      (await store.get(card.id))?.metadata?.automation?.target?.worktree?.handoff,
    ).toMatchObject({
      phase: "imported",
      verify: true,
    });
    expect(verifier.creates).toEqual([
      expect.objectContaining({
        key: `agent:verifier:verify-${card.id.slice(0, 8)}-r0-v0`,
        agentId: "verifier",
        model: "openai/gpt-6-sol",
        execNode: repos.target.nodeId,
        cwd: verifyPath,
        category: "Verification",
      }),
    ]);
    const message = String((verifier.creates[0] as { message: string }).message);
    expect(message).toContain(card.title);
    expect(message).toContain(notes);
    expect(message).toContain(`${base}..${head}`);
    // Blind to the author: the done report's summary and proof stay out of the brief.
    expect(message).not.toContain("Parser accepts empty input");
    expect(message).not.toContain('pytest"');
    expect(git(verifyPath, "rev-parse", "HEAD")).toBe(head);
    expect(git(verifyPath, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
    const running = expect.objectContaining({
      phase: "running",
      round: 0,
      headCommit: head,
      sessionKey: `agent:verifier:verify-${card.id.slice(0, 8)}-r0-v0`,
      path: verifyPath,
      model: "openai/gpt-6-sol",
    });
    await expect(ticket.verificationOf()).resolves.toEqual(running);
    expect(workboardCardConsumesNodeTicketSlot((await store.get(card.id))!, Date.now())).toBe(true);

    // The verifier is still at work: the pass neither creates again nor wakes the review.
    await handoffs.resume(warn);
    expect(verifier.creates).toHaveLength(1);
    expect(onReview).not.toHaveBeenCalled();
    await expect(ticket.verificationOf()).resolves.toEqual(running);

    verifier.running = false;
    verifier.history = verificationReply({
      verdict: "fail",
      summary: 'pytest passes, but `parse("")` raises on a whitespace-only input.',
      findings: [{ path: "parser.py", line: 1, body: "whitespace-only input raises" }],
    });
    await handoffs.resume(warn);

    expect(warn).not.toHaveBeenCalled();
    expect(onReview).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: card.id, status: "review" }),
    );
    await expect(ticket.verificationOf()).resolves.toEqual({
      phase: "done",
      round: 0,
      headCommit: head,
      startedAt: expect.any(Number),
      endedAt: expect.any(Number),
      sessionKey: `agent:verifier:verify-${card.id.slice(0, 8)}-r0-v0`,
      model: "openai/gpt-6-sol",
      verdict: "fail",
      summary: 'pytest passes, but `parse("")` raises on a whitespace-only input.',
      findings: [{ path: "parser.py", line: 1, body: "whitespace-only input raises" }],
    });
    expect(existsSync(verifyPath)).toBe(false);
    const stored = await store.get(card.id);
    expect(stored?.metadata?.comments?.at(-1)).toMatchObject({
      source: "agent:verifier",
      body: [
        "**Verification:** fail (openai/gpt-6-sol)",
        "",
        'pytest passes, but `parse("")` raises on a whitespace-only input.',
        "",
        "- `parser.py:1` whitespace-only input raises",
      ].join("\n"),
    });
    expect(workboardCardConsumesNodeTicketSlot(stored!, Date.now())).toBe(false);

    // The operator's re-run drops the result; the next pass verifies the round
    // again in a fresh session, numbered by the comments the round's runs posted.
    await store.dropNodeVerification(card.id);
    verifier.history = verificationReply({ verdict: "pass", summary: "all green" });
    await handoffs.resume(warn);
    expect(verifier.creates).toHaveLength(2);
    expect(verifier.creates[1]).toMatchObject({
      key: `agent:verifier:verify-${card.id.slice(0, 8)}-r0-v1`,
      cwd: verifyPath,
    });
    await expect(ticket.verificationOf()).resolves.toMatchObject({
      phase: "running",
      sessionKey: `agent:verifier:verify-${card.id.slice(0, 8)}-r0-v1`,
    });
    verifier.running = false;
    await handoffs.resume(warn);
    await expect(ticket.verificationOf()).resolves.toMatchObject({
      phase: "done",
      verdict: "pass",
      summary: "all green",
      findings: [],
    });
    expect(onReview).toHaveBeenCalledTimes(2);
    await expect(store.dropNodeVerification(card.id)).resolves.toMatchObject({ id: card.id });
    await expect(ticket.verificationOf()).resolves.toBeUndefined();
  });

  it("adopts a running verifier session whose record was lost, and copies the verdict to the publish", async () => {
    const ticket = await verifiedTicket();
    const { store, card, repos, handoffs, warn, onReview, verifier, github } = ticket;
    const lost = vi
      .spyOn(store, "setNodeVerification")
      .mockImplementationOnce(async () => undefined);

    await handoffs.resume(warn);
    expect(verifier.creates).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("was not recorded"));
    await expect(ticket.verificationOf()).resolves.toBeUndefined();
    lost.mockRestore();
    warn.mockClear();

    await handoffs.resume(warn);
    expect(verifier.creates).toHaveLength(1);
    await expect(ticket.verificationOf()).resolves.toMatchObject({
      phase: "running",
      sessionKey: `agent:verifier:verify-${card.id.slice(0, 8)}-r0-v0`,
    });

    // A reply without the block, or with two, cannot finish: an error verdict that does not hold the card.
    verifier.running = false;
    verifier.history = [{ role: "assistant", content: "I ran the tests and they pass." }];
    await handoffs.resume(warn);
    expect(warn).not.toHaveBeenCalled();
    expect(onReview).toHaveBeenCalledOnce();
    await expect(ticket.verificationOf()).resolves.toMatchObject({
      phase: "done",
      verdict: "error",
      summary: "The verifier's last reply has no workboard-verification block.",
    });
    expect((await store.get(card.id))?.metadata?.comments?.at(-1)?.body).toContain(
      "**Verification:** error (openai/gpt-6-sol)",
    );

    git(repos.hostRepo, "remote", "set-url", "origin", "git@github.com:acme/app.git");
    github.tokens.set("acme/app", "token-app");
    await moveDoneAfterReviewDeadline(store, card.id);
    await handoffs.resume(warn);
    expect((await store.get(card.id))?.metadata?.automation?.target?.worktree?.reviews).toEqual([
      expect.objectContaining({
        round: 0,
        verdict: "missed",
        verification: {
          verdict: "error",
          model: "openai/gpt-6-sol",
          startedAt: expect.any(Number),
          endedAt: expect.any(Number),
        },
      }),
    ]);
  });

  it("keeps the verifier's reason when it reports that it could not finish the proof", async () => {
    const { store, card, handoffs, warn, verifier, verificationOf } = await verifiedTicket();
    await handoffs.resume(warn);
    verifier.running = false;
    verifier.history = verificationReply({
      verdict: "error",
      summary: "Tests passed; the simulator stalled and the node disconnected.",
      findings: [{ path: "a.swift", body: "not a defect" }],
    });
    await handoffs.resume(warn);
    await expect(verificationOf()).resolves.toMatchObject({
      phase: "done",
      verdict: "error",
      summary: "Tests passed; the simulator stalled and the node disconnected.",
      findings: [],
    });
    expect((await store.get(card.id))?.metadata?.comments?.at(-1)?.body).toContain(
      "the simulator stalled and the node disconnected",
    );
  });

  it("keeps a just-started verification running until its session replies or the start grace ends", async () => {
    const ticket = await verifiedTicket();
    const { store, card, handoffs, warn, onReview, verifier } = ticket;
    await handoffs.resume(warn);

    // The session view does not list the new run yet and nothing has replied.
    verifier.running = false;
    await handoffs.resume(warn);
    expect(onReview).not.toHaveBeenCalled();
    const running = await ticket.verificationOf();
    if (running?.phase !== "running") {
      throw new Error(`expected a running verification, got ${running?.phase}`);
    }

    const worktreePath = (await store.get(card.id))!.metadata!.automation!.target!.worktree!.path;
    await store.setNodeVerification(card.id, {
      worktreePath,
      verification: { ...running, startedAt: Date.now() - 3 * 60_000 },
    });
    await handoffs.resume(warn);
    expect(onReview).toHaveBeenCalledOnce();
    await expect(ticket.verificationOf()).resolves.toMatchObject({
      phase: "done",
      verdict: "error",
    });
  });

  it("reads the board only for a round whose verification could start", async () => {
    const ticket = await verifiedTicket();
    const { store, repos, handoffs, warn, verifier } = ticket;
    const boardReads = vi.spyOn(store, "boardOrchestration");
    await handoffs.resume(warn);
    // One read stamps the import, one starts the verification.
    expect(boardReads).toHaveBeenCalledTimes(2);
    expect(verifier.creates).toHaveLength(1);

    // A plain card, a ticket in the pool, and a running verification need no board read.
    await store.create({ title: "Write the release notes", status: "todo" });
    await startNodeCard(store, ticket.gateway, repos.target);
    boardReads.mockClear();
    await handoffs.resume(warn);
    expect(boardReads).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("settles a verification still running after the operator decided or archived the card", async () => {
    const verifyPathOf = (ticket: {
      repos: { target: { worktreesRoot: string } };
      card: WorkboardCard;
    }) => path.join(ticket.repos.target.worktreesRoot, `verify-${ticket.card.id.slice(0, 8)}-r0`);

    const decided = await verifiedTicket();
    await decided.handoffs.resume(decided.warn);
    git(decided.repos.hostRepo, "remote", "set-url", "origin", "git@github.com:acme/app.git");
    decided.github.tokens.set("acme/app", "token-app");
    await moveDoneAfterReviewDeadline(decided.store, decided.card.id);
    await decided.handoffs.resume(decided.warn);
    // The publish went ahead without the verification, which still holds the node slot.
    const published = (await decided.store.get(decided.card.id))!;
    expect(published.metadata?.automation?.target?.worktree?.handoff?.phase).toBe("published");
    expect(published.metadata?.automation?.target?.worktree?.reviews?.[0]).not.toHaveProperty(
      "verification",
    );
    expect(workboardCardConsumesNodeTicketSlot(published, Date.now())).toBe(true);
    await expect(decided.verificationOf()).resolves.toMatchObject({ phase: "running" });

    decided.verifier.running = false;
    decided.verifier.history = verificationReply({ verdict: "pass", summary: "all green" });
    await decided.handoffs.resume(decided.warn);
    expect(decided.warn).not.toHaveBeenCalled();
    expect(decided.onReview).not.toHaveBeenCalled();
    await expect(decided.verificationOf()).resolves.toMatchObject({
      phase: "done",
      verdict: "pass",
    });
    expect(existsSync(verifyPathOf(decided))).toBe(false);
    const settled = (await decided.store.get(decided.card.id))!;
    expect(settled.metadata?.comments?.at(-1)?.body).toContain("**Verification:** pass");
    expect(workboardCardConsumesNodeTicketSlot(settled, Date.now())).toBe(false);

    const archived = await verifiedTicket();
    await archived.handoffs.resume(archived.warn);
    await archived.store.archive(archived.card.id, true);
    expect(
      workboardCardConsumesNodeTicketSlot(
        (await archived.store.get(archived.card.id))!,
        Date.now(),
      ),
    ).toBe(true);
    archived.verifier.running = false;
    archived.verifier.history = verificationReply({
      verdict: "fail",
      summary: "the parser still raises",
      findings: [{ path: "parser.py", body: "raises on whitespace" }],
    });
    await archived.handoffs.resume(archived.warn);
    expect(archived.warn).not.toHaveBeenCalled();
    expect(archived.onReview).not.toHaveBeenCalled();
    await expect(archived.verificationOf()).resolves.toMatchObject({
      phase: "done",
      verdict: "fail",
    });
    expect(existsSync(verifyPathOf(archived))).toBe(false);
    expect(
      (await archived.store.get(archived.card.id))?.metadata?.comments?.at(-1)?.body,
    ).toContain("**Verification:** fail");
  });

  it("keeps a running verification across the rework launch and settles it on the new round", async () => {
    const ticket = await verifiedTicket();
    const { store, card, repos, handoffs, warn, onReview, verifier, github } = ticket;
    const verifyPath = path.join(repos.target.worktreesRoot, `verify-${card.id.slice(0, 8)}-r0`);
    await handoffs.resume(warn);
    git(repos.hostRepo, "remote", "set-url", "origin", "git@github.com:acme/app.git");
    github.tokens.set("acme/app", "token-app");
    await store.addComment(
      card.id,
      { body: "Verdict: rework: whitespace input still raises" },
      undefined,
      "agent:dev",
    );
    await moveDoneAfterReviewDeadline(store, card.id);
    await handoffs.resume(warn);
    expect((await store.get(card.id))?.metadata?.automation?.target?.worktree?.handoff?.phase).toBe(
      "published",
    );

    // The reopen launches rework round 1 while round 0's verifier still runs.
    await store.move(card.id, "todo", undefined);
    await store.addComment(card.id, { body: "Handle whitespace-only input." });
    await handoffs.resume(warn);
    expect(warn).not.toHaveBeenCalled();
    const launched = (await store.get(card.id))!;
    expect(launched.status).toBe("running");
    expect(launched.metadata?.automation?.target?.worktree?.rework?.round).toBe(1);
    await expect(ticket.verificationOf()).resolves.toMatchObject({ phase: "running", round: 0 });

    verifier.running = false;
    verifier.history = verificationReply({ verdict: "pass", summary: "all green" });
    await handoffs.resume(warn);
    expect(warn).not.toHaveBeenCalled();
    expect(onReview).not.toHaveBeenCalled();
    await expect(ticket.verificationOf()).resolves.toMatchObject({
      phase: "done",
      round: 0,
      verdict: "pass",
    });
    expect(existsSync(verifyPath)).toBe(false);
    expect((await store.get(card.id))?.status).toBe("running");
  });

  it("records a verifier session that cannot start as an error and wakes the review", async () => {
    const ticket = await verifiedTicket({ failCreate: "model not allowed: openai/gpt-6-sol" });
    const { store, card, repos, handoffs, warn, onReview } = ticket;

    await handoffs.resume(warn);

    expect(warn).not.toHaveBeenCalled();
    expect(onReview).toHaveBeenCalledOnce();
    await expect(ticket.verificationOf()).resolves.toMatchObject({
      phase: "done",
      verdict: "error",
      model: "openai/gpt-6-sol",
      summary: "The verification could not start: model not allowed: openai/gpt-6-sol",
      findings: [],
    });
    expect((await store.get(card.id))?.status).toBe("review");
    // The worktree the failed start added does not outlive it.
    expect(
      existsSync(path.join(repos.target.worktreesRoot, `verify-${card.id.slice(0, 8)}-r0`)),
    ).toBe(false);
  });
});
