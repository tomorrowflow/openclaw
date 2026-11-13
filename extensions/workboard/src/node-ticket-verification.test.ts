// Workboard tests cover the independent verification of a node ticket's imported round.
import { existsSync } from "node:fs";
import path from "node:path";
import type { WorkboardCard } from "@openclaw/workboard-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkboardLifecycleSessionReader } from "./lifecycle-sessions.js";
import { crossVerifies, parseVerificationReply } from "./node-ticket-verification.js";
import { cardInSample } from "./node-ticket.js";
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
const CROSS_VERIFIER = { agentId: "verifier-claude", model: "anthropic/claude-opus-5-5" };

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
async function verifiedTicket(
  params: {
    notes?: string;
    failCreate?: string;
    docsRung?: "b" | "c";
    cross?: boolean | { sampleEvery: number };
    fallbacks?: string[];
    refuse?: string[];
    beforeCommit?: Parameters<typeof finishNodeTicket>[0]["beforeCommit"];
  } = {},
) {
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
  const ticket = await finishNodeTicket({
    onReview,
    readSessions,
    docsRung: params.docsRung,
    beforeCommit: params.beforeCommit,
  });
  await ticket.store.upsertBoard({
    id: "default",
    orchestration: {
      verifier: { ...VERIFIER, ...(params.fallbacks ? { fallbacks: params.fallbacks } : {}) },
      ...(params.cross
        ? { crossVerifier: { ...CROSS_VERIFIER, ...(params.cross === true ? {} : params.cross) } }
        : {}),
    },
  });
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
      const model = String(requestParams?.model);
      if (params.refuse?.includes(model)) {
        throw new Error(`${model} is temporarily unavailable`);
      }
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
            resolved: {
              modelProvider: String(requestParams?.model).split("/")[0],
              model: String(requestParams?.model).split("/").slice(1).join("/"),
            },
          };
    }
    return answer(method, requestParams);
  });
  const verificationOf = async () =>
    (await ticket.store.get(ticket.card.id))?.metadata?.automation?.target?.worktree?.verification;
  const crossVerificationOf = async () =>
    (await ticket.store.get(ticket.card.id))?.metadata?.automation?.target?.worktree
      ?.crossVerification;
  return { ...ticket, onReview, verifier, verificationOf, crossVerificationOf };
}

describe("node ticket verification", () => {
  it("hands the verifier the round's own range when the session pulled main mid-ticket", async () => {
    const ticket = await verifiedTicket({
      beforeCommit: (worktree, repos) => {
        git(repos.origin, "commit", "-q", "--allow-empty", "-m", "another ticket");
        git(worktree, "fetch", "-q", "origin");
        git(worktree, "merge", "-q", "--ff-only", "origin/main");
      },
    });
    const base = git(ticket.repos.target.repoPath, "rev-parse", "main");
    const pulled = git(ticket.repos.origin, "rev-parse", "main");
    const head = git(ticket.worktree, "rev-parse", "HEAD");

    await ticket.handoffs.resume(ticket.warn);

    const message = (ticket.verifier.creates[0] as { message: string }).message;
    expect(message).toContain(`The round's range is \`${pulled}..${head}\``);
    expect(message).not.toContain(base);
  });

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
    const message = (verifier.creates[0] as { message: string }).message;
    expect(message).toContain(card.title);
    expect(message).toContain(notes);
    expect(message).toContain(`${base}..${head}`);
    // Its own simulator, named like its session, so it never tests on a ticket session's.
    expect(message).toContain(`xcrun simctl create verify-${card.id.slice(0, 8)}-r0 "<device>"`);
    expect(message).toContain("sips -Z 800 -s format jpeg");
    expect(message).toContain('image("data:image/jpeg;base64,<base64>")');
    expect(message).toContain('"visual":{"verdict":"looks_right|problem|not_checked"');
    expect(message).toContain(
      "What you saw on the screenshots goes only in `visual`, never in `summary` or `findings`",
    );
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
      visual: { verdict: "not_checked", screenshots: [] },
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

  it("cross-verifies a rung c round after its verification passed, before waking the board automation", async () => {
    const ticket = await verifiedTicket({ docsRung: "c", cross: true });
    const { store, card, handoffs, warn, onReview, verifier } = ticket;
    const name = `verify-${card.id.slice(0, 8)}-r0`;

    await handoffs.resume(warn);
    expect(
      (await store.get(card.id))?.metadata?.automation?.target?.worktree?.handoff,
    ).toMatchObject({ phase: "imported", verify: true, crossVerify: true });
    expect(verifier.creates).toEqual([
      expect.objectContaining({ key: `agent:verifier:${name}-v0`, agentId: "verifier" }),
    ]);

    // The verification passes: the same pass starts the cross-verifier, and the review still waits.
    verifier.running = false;
    verifier.history = verificationReply({ verdict: "pass", summary: "pytest green" });
    await handoffs.resume(warn);
    expect(verifier.creates).toHaveLength(2);
    expect(verifier.creates[1]).toMatchObject({
      key: `agent:verifier-claude:${name}-x1`,
      agentId: "verifier-claude",
      model: "anthropic/claude-opus-5-5",
      cwd: path.join(ticket.repos.target.worktreesRoot, name),
    });
    expect(onReview).not.toHaveBeenCalled();
    await expect(ticket.verificationOf()).resolves.toMatchObject({
      phase: "done",
      verdict: "pass",
    });
    await expect(ticket.crossVerificationOf()).resolves.toMatchObject({
      phase: "running",
      sessionKey: `agent:verifier-claude:${name}-x1`,
    });
    expect(workboardCardConsumesNodeTicketSlot((await store.get(card.id))!, Date.now())).toBe(true);

    verifier.running = false;
    verifier.history = verificationReply({
      verdict: "fail",
      summary: "whitespace-only input raises",
      findings: [{ path: "parser.py", line: 1, body: "whitespace-only input raises" }],
    });
    await handoffs.resume(warn);

    expect(warn).not.toHaveBeenCalled();
    expect(verifier.creates).toHaveLength(2);
    expect(onReview).toHaveBeenCalledOnce();
    await expect(ticket.crossVerificationOf()).resolves.toMatchObject({
      phase: "done",
      verdict: "fail",
      sessionKey: `agent:verifier-claude:${name}-x1`,
    });
    expect((await store.get(card.id))?.metadata?.comments?.at(-1)).toMatchObject({
      source: "agent:verifier-claude",
      body: expect.stringMatching(/^\*\*Verification:\*\* fail/),
    });

    // The operator's re-run drops both; the cross-verifier runs again after the next pass.
    await store.dropNodeVerification(card.id);
    await expect(ticket.crossVerificationOf()).resolves.toBeUndefined();
  });

  it("cross-verifies only the rung c rounds in the cross-verifier's sample, chosen at import", async () => {
    const ticket = await verifiedTicket({ docsRung: "c", cross: { sampleEvery: 100 } });
    // A sample size that leaves this card out; all six at once would need a 1-in-30030 id.
    const left = [2, 3, 5, 7, 11, 13].find(
      (every) => !cardInSample(`cross:${ticket.card.id}`, every),
    )!;
    await ticket.store.upsertBoard({
      id: "default",
      orchestration: {
        verifier: VERIFIER,
        crossVerifier: { ...CROSS_VERIFIER, sampleEvery: left },
      },
    });
    await ticket.handoffs.resume(ticket.warn);
    const handoff = (await ticket.store.get(ticket.card.id))?.metadata?.automation?.target?.worktree
      ?.handoff;
    expect(handoff).toMatchObject({ phase: "imported", verify: true });
    expect(handoff?.phase === "imported" && handoff.crossVerify).toBeUndefined();

    ticket.verifier.running = false;
    ticket.verifier.history = verificationReply({ verdict: "pass", summary: "pytest green" });
    await ticket.handoffs.resume(ticket.warn);
    expect(ticket.verifier.creates).toHaveLength(1);
    expect(ticket.onReview).toHaveBeenCalledOnce();
    await expect(ticket.crossVerificationOf()).resolves.toBeUndefined();
  });

  it("never cross-verifies a rung c round whose verification failed, nor a rung b round", async () => {
    for (const [docsRung, verdict] of [
      ["c", "fail"],
      ["b", "pass"],
    ] as const) {
      const ticket = await verifiedTicket({ docsRung, cross: true });
      await ticket.handoffs.resume(ticket.warn);
      ticket.verifier.running = false;
      ticket.verifier.history = verificationReply({
        verdict,
        summary: verdict,
        findings: verdict === "fail" ? [{ path: "parser.py", body: "broken" }] : [],
      });
      await ticket.handoffs.resume(ticket.warn);

      expect(ticket.verifier.creates).toHaveLength(1);
      expect(ticket.onReview).toHaveBeenCalledOnce();
      await expect(ticket.crossVerificationOf()).resolves.toBeUndefined();
      // A failed verification ends the wait: the cross-verifier would only confirm the rework.
      const handoff = (await ticket.store.get(ticket.card.id))?.metadata?.automation?.target
        ?.worktree?.handoff;
      expect(handoff?.phase === "imported" && handoff.crossVerify).toBe(
        docsRung === "c" ? true : undefined,
      );
    }
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
          sessionKey: `agent:verifier:verify-${card.id.slice(0, 8)}-r0-v0`,
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

  it("records the verifier's visual read beside a verdict it never changes, and keeps it out of the comment", async () => {
    const { store, card, handoffs, warn, verifier, verificationOf } = await verifiedTicket();
    await handoffs.resume(warn);
    verifier.running = false;
    const visual = {
      verdict: "problem",
      screenshots: [
        {
          path: "docs/screenshots/A49/today-dark.png",
          shows: "Today tab selected; the Record button stays light grey in dark mode",
          verdict: "problem",
        },
        {
          path: "docs/screenshots/A49/today-light.png",
          shows: "Today tab selected; Record button filled blue",
          verdict: "looks_right",
        },
      ],
    };
    verifier.history = verificationReply({
      verdict: "pass",
      summary: "xcodebuild test passed",
      visual,
    });
    await handoffs.resume(warn);

    await expect(verificationOf()).resolves.toMatchObject({
      phase: "done",
      verdict: "pass",
      visual,
    });
    const comment = (await store.get(card.id))?.metadata?.comments?.at(-1)?.body ?? "";
    expect(comment).toBe("**Verification:** pass (openai/gpt-6-sol)\n\nxcodebuild test passed");
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
  it("starts the verifier on the board's next fallback when the Gateway refuses its model", async () => {
    const ticket = await verifiedTicket({
      fallbacks: ["ollama/kimi-k3:cloud", "ollama/glm-5.3:cloud"],
      refuse: ["openai/gpt-6-sol"],
    });
    const { card, handoffs, warn, verifier } = ticket;

    await handoffs.resume(warn);

    expect(warn).not.toHaveBeenCalled();
    expect(verifier.creates.map((create) => (create as { model: string }).model)).toEqual([
      "openai/gpt-6-sol",
      "ollama/kimi-k3:cloud",
    ]);
    expect(new Set(verifier.creates.map((create) => (create as { key: string }).key))).toEqual(
      new Set([`agent:verifier:verify-${card.id.slice(0, 8)}-r0-v0`]),
    );
    await expect(ticket.verificationOf()).resolves.toMatchObject({
      phase: "running",
      model: "ollama/kimi-k3:cloud",
    });
  });

  it("names every refused model when no configured model can start", async () => {
    const ticket = await verifiedTicket({
      fallbacks: ["ollama/kimi-k3:cloud"],
      refuse: ["openai/gpt-6-sol", "ollama/kimi-k3:cloud"],
    });

    await ticket.handoffs.resume(ticket.warn);

    await expect(ticket.verificationOf()).resolves.toMatchObject({
      phase: "done",
      verdict: "error",
      summary:
        "The verification could not start: openai/gpt-6-sol: openai/gpt-6-sol is temporarily unavailable; ollama/kimi-k3:cloud: ollama/kimi-k3:cloud is temporarily unavailable",
    });
  });
});

describe("crossVerifies", () => {
  const card = { id: "card-1", metadata: {} } as WorkboardCard;
  const board = { verifier: VERIFIER, crossVerifier: { ...CROSS_VERIFIER, sampleEvery: 2 } };
  const sampled = cardInSample(`cross:${card.id}`, 2);

  it("picks every rung c round without a sample, else reworked rounds and 1 in sampleEvery", () => {
    expect(
      crossVerifies(card, { rung: "c" }, { verifier: VERIFIER, crossVerifier: CROSS_VERIFIER }),
    ).toBe(true);
    expect(crossVerifies(card, { rung: "c" }, board)).toBe(sampled);
    expect(
      crossVerifies(
        card,
        {
          rung: "c",
          rework: {
            round: 1,
            pullRequestUrl: "https://github.com/acme/app/pull/1",
            acceptedAt: 1,
            outsideCommits: 0,
          },
        },
        board,
      ),
    ).toBe(true);
  });

  it("never picks a rung b round, a probe, or a board without both verifiers", () => {
    expect(
      crossVerifies(card, { rung: "b" }, { verifier: VERIFIER, crossVerifier: CROSS_VERIFIER }),
    ).toBe(false);
    expect(
      crossVerifies(
        {
          ...card,
          metadata: { automation: { probe: { kind: "egress" } } },
        } as unknown as WorkboardCard,
        { rung: "c" },
        { verifier: VERIFIER, crossVerifier: CROSS_VERIFIER },
      ),
    ).toBe(false);
    expect(crossVerifies(card, { rung: "c" }, { verifier: VERIFIER })).toBe(false);
    expect(crossVerifies(card, { rung: "c" }, { crossVerifier: CROSS_VERIFIER })).toBe(false);
  });
});

describe("parseVerificationReply visual read", () => {
  const reply = (block: unknown) =>
    `\`\`\`workboard-verification\n${JSON.stringify(block)}\n\`\`\``;
  const notChecked = { verdict: "not_checked", screenshots: [] };

  it("defaults a missing or malformed visual read to not_checked", () => {
    expect(parseVerificationReply(reply({ verdict: "pass" })).visual).toEqual(notChecked);
    expect(parseVerificationReply(reply({ verdict: "pass", visual: "fine" })).visual).toEqual(
      notChecked,
    );
    expect(
      parseVerificationReply(reply({ verdict: "pass", visual: { verdict: "great" } })).visual,
    ).toEqual(notChecked);
    expect(parseVerificationReply("no block").visual).toEqual(notChecked);
  });

  it("drops malformed screenshots, caps the list at 12, and bounds what each shows", () => {
    const shot = (index: number) => ({
      path: `docs/screenshots/A49/${index}.png`,
      shows: `Screen ${index}`,
      verdict: "looks_right",
    });
    const parsed = parseVerificationReply(
      reply({
        verdict: "fail",
        findings: [{ path: "App.swift", body: "crashes on launch" }],
        visual: {
          verdict: "looks_right",
          screenshots: [
            { path: "a.png", shows: "no verdict" },
            { path: "", shows: "no path", verdict: "problem" },
            { path: "b.png", shows: "  ", verdict: "problem" },
            { path: "c.png", shows: "x".repeat(500), verdict: "problem" },
            ...Array.from({ length: 14 }, (_, index) => shot(index)),
          ],
        },
      }),
    );

    expect(parsed.verdict).toBe("fail");
    expect(parsed.visual.verdict).toBe("looks_right");
    expect(parsed.visual.screenshots).toHaveLength(12);
    expect(parsed.visual.screenshots[0]).toEqual({
      path: "c.png",
      shows: `${"x".repeat(199)}…`,
      verdict: "problem",
    });
    expect(parsed.visual.screenshots[11]).toEqual(shot(10));
  });

  it("keeps the verdict whatever the visual read says, and an error keeps its visual read", () => {
    const visual = {
      verdict: "problem",
      screenshots: [{ path: "dark.png", shows: "unreadable label", verdict: "problem" }],
    };
    expect(parseVerificationReply(reply({ verdict: "pass", visual }))).toMatchObject({
      verdict: "pass",
      visual,
    });
    expect(
      parseVerificationReply(reply({ verdict: "error", summary: "simulator stalled", visual })),
    ).toMatchObject({ verdict: "error", findings: [], visual });
  });
});
