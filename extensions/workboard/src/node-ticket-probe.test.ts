// Workboard tests cover probe cards: past node tickets re-run under a harness arm.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorkboardCard } from "@openclaw/workboard-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import { syncWorkboardAgentEnded, type WorkboardLifecycleSessionReader } from "./lifecycle-sync.js";
import { createNodeTicketHandoffs } from "./node-ticket-handoff.js";
import {
  createFakeGitHub,
  createLocalNodeGateway,
  createNodeRepos,
  endedSession,
  git,
  startNodeCard,
} from "./node-ticket.test-support.js";
import { cardRunId, cardSessionKey } from "./store-card-helpers.js";
import type { WorkboardStore } from "./store.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";
import { createWorkboardTools } from "./tools.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const VERIFIER = { agentId: "verifier", model: "openai/gpt-6-sol" };
const NOTES = "Spec: empty input returns [].\n\nProof: `pytest tests/test_parser.py`.";

function reply(report: Record<string, unknown>, fence = "workboard-report") {
  return [
    { role: "assistant", content: `Done.\n\n\`\`\`${fence}\n${JSON.stringify(report)}\n\`\`\`` },
  ];
}

const doneReport = reply({
  outcome: "done",
  summary: "Parser accepts empty input",
  proof: [{ command: "pytest", status: "passed" }],
});

/**
 * A node ticket whose round the handoff pass imported, on a board with a
 * verifier when `verifier` is set. The fake Gateway runs node commands on
 * local repos; a verifier session runs while `verifier.running` and its last
 * reply is `verifier.history`.
 */
async function importedSource(params: { verifier?: boolean } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "workboard-probe-"));
  roots.push(root);
  const repos = createNodeRepos(root);
  const store = createWorkboardSqliteTestStore();
  const gateway = createLocalNodeGateway();
  const verifier = { running: false, history: [] as unknown[], creates: [] as unknown[] };
  const answer = gateway.respond.getMockImplementation();
  gateway.respond.mockImplementation((method, requestParams) => {
    if (method === "chat.history") {
      return { messages: verifier.history };
    }
    if (method === "sessions.create" && String(requestParams?.key).includes(":verify-")) {
      verifier.creates.push(requestParams);
      verifier.running = true;
      return {
        ok: true,
        key: requestParams?.key,
        runId: "run-verify",
        runStarted: true,
        resolved: { modelProvider: "openai", model: "gpt-6-sol" },
      };
    }
    return answer?.(method, requestParams);
  });
  const readSessions: WorkboardLifecycleSessionReader = async ({ sessionKey }) => ({
    sessions: sessionKey
      ? [
          {
            key: sessionKey,
            hasActiveRun: sessionKey.includes(":verify-") && verifier.running,
            updatedAt: Date.now(),
          },
        ]
      : [],
    complete: true,
  });
  const { card } = await startNodeCard(store, gateway, repos.target);
  await store.update(card.id, { notes: NOTES, labels: ["class:server-fix", "trial:poteto"] });
  await finishRun(store, repos.target.worktreesRoot, card.id, doneReport);
  const onReview = vi.fn(async (_card: WorkboardCard) => {});
  const github = createFakeGitHub(repos.origin);
  const handoffs = createNodeTicketHandoffs({
    store,
    runtime: gateway,
    github: github.access,
    start: async (cardId, queue) =>
      await dispatchAndStartWorkboardCards({
        store,
        subagent: { run: vi.fn() },
        nodeTickets: gateway,
        options: { cardId, queue },
      }),
    onReview,
    readSessions,
  });
  const warn = vi.fn();
  if (params.verifier) {
    await store.upsertBoard({ id: "default", orchestration: { verifier: VERIFIER } });
  }
  await handoffs.resume(warn);
  if (params.verifier) {
    verifier.running = false;
    verifier.history = reply({ verdict: "pass", summary: "all green" }, "workboard-verification");
    await handoffs.resume(warn);
  }
  /** Starts `probe` through the operator's start path and ends its run with `messages`. */
  const runProbe = async (probe: WorkboardCard, messages: unknown[] = doneReport) => {
    const { started } = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run: vi.fn() },
      nodeTickets: gateway,
      options: { cardId: probe.id, queue: "request" },
    });
    expect(started[0], "the probe started").toBeDefined();
    return await finishRun(store, repos.target.worktreesRoot, probe.id, messages);
  };
  return { store, card, repos, gateway, github, handoffs, warn, onReview, verifier, runProbe };
}

/** Commits in the card's node worktree and ends its running session with `messages`. */
async function finishRun(
  store: WorkboardStore,
  worktreesRoot: string,
  cardId: string,
  messages: unknown[],
) {
  const card = await store.get(cardId);
  const runId = card && cardRunId(card);
  const sessionKey = card && cardSessionKey(card);
  const worktree = path.join(worktreesRoot, `wb-${cardId}`);
  writeFileSync(path.join(worktree, "parser.py"), `${cardId}\n`);
  git(worktree, "add", "-A");
  git(worktree, "commit", "-q", "-m", "fix parser");
  await syncWorkboardAgentEnded({
    store,
    event: { runId, success: true, messages },
    context: { runId, sessionKey },
    readSessions: endedSession(),
  });
  return worktree;
}

describe("node ticket probes", () => {
  it("re-runs a ticket from its base under an arm, verifies it, and archives it without a review", async () => {
    const source = await importedSource({ verifier: true });
    const { store, card, repos, handoffs, warn, onReview, verifier } = source;
    expect(onReview).toHaveBeenCalledOnce();
    const base = (await store.get(card.id))?.metadata?.automation?.target?.worktree?.baseCommit;
    git(repos.origin, "commit", "-q", "--allow-empty", "-m", "main moved on");

    const { card: probe, created } = await store.createNodeProbe(card.id, {
      arm: "poteto",
      model: "anthropic/claude-opus-5-5",
      note: "**Mode:** poteto",
    });

    expect(created).toBe(true);
    expect(probe).toMatchObject({
      title: `[PROBE:poteto] ${card.title}`,
      status: "todo",
      agentId: "dev",
      labels: ["class:server-fix", "probe", "probe:poteto"],
      notes: `${NOTES}\n\n**Mode:** poteto`,
    });
    expect(probe.metadata?.automation?.target).toEqual({
      ...repos.target,
      baseRef: base,
      model: "anthropic/claude-opus-5-5",
    });
    expect(probe.metadata?.automation?.probe).toEqual({
      of: card.id,
      arm: "poteto",
      createdAt: expect.any(Number),
    });
    await expect(store.createNodeProbe(card.id, { arm: "poteto" })).resolves.toEqual({
      card: probe,
      created: false,
    });
    await expect(store.createNodeProbe(probe.id, { arm: "base" })).rejects.toThrow(
      `card ${probe.id} is a probe; probe its source card ${card.id}.`,
    );
    await expect(store.createNodeProbe(card.id, { arm: "Poteto!" })).rejects.toThrow(
      "arm must match",
    );
    const plain = await store.create({ title: "Not a node ticket" });
    await expect(store.createNodeProbe(plain.id, { arm: "base" })).rejects.toThrow(
      "is not a node ticket that ran",
    );

    const worktree = await source.runProbe(probe);
    expect(git(worktree, "rev-parse", "HEAD~1")).toBe(base);
    await handoffs.resume(warn);

    expect(verifier.creates).toHaveLength(2);
    expect(verifier.creates[1]).toMatchObject({
      key: `agent:verifier:verify-${probe.id.slice(0, 8)}-r0-v0`,
    });
    expect((await store.get(probe.id))?.metadata?.archivedAt).toBeUndefined();

    verifier.running = false;
    verifier.history = reply(
      {
        verdict: "fail",
        summary: "Whitespace-only input raises.",
        findings: [{ path: "parser.py", line: 1, body: "whitespace-only input raises" }],
      },
      "workboard-verification",
    );
    await handoffs.resume(warn);

    expect(warn).not.toHaveBeenCalled();
    expect(onReview).toHaveBeenCalledOnce();
    const archived = await store.get(probe.id);
    expect(archived?.status).toBe("review");
    expect(archived?.metadata?.archivedAt).toEqual(expect.any(Number));
    expect(archived?.metadata?.comments?.at(-1)?.body).toBe(
      "**Probe poteto:** done, verification fail (openai/gpt-6-sol), 1 findings. Archived; it is never published.\n\nWhitespace-only input raises.",
    );

    const { card: rerun, created: again } = await store.createNodeProbe(card.id, {
      arm: "poteto",
    });
    expect(again).toBe(true);
    const { card: baseArm } = await store.createNodeProbe(card.id, { arm: "base" });
    const devTools = new Map(
      createWorkboardTools({ store, context: { agentId: "dev" } }).map((tool) => [tool.name, tool]),
    );
    await expect(
      devTools.get("workboard_move")?.execute("move", { id: baseArm.id, status: "ready" }),
    ).rejects.toThrow("Probe cards are not reviewed.");
    // Only the source counts; the probes waiting in todo are not the loop's work.
    expect((await store.trust({ boardId: "default" })).total.tickets).toBe(1);
    expect((await store.probes({ boardId: "default" })).probes).toEqual([
      expect.objectContaining({ arm: "base", cardId: baseArm.id, outcome: "running" }),
      {
        of: card.id,
        ofTitle: card.title,
        source: { accepted: false, clean: true, reworkRounds: 0 },
        arm: "poteto",
        cardId: probe.id,
        status: "review",
        outcome: "done",
        verification: { verdict: "fail", findings: 1, model: "openai/gpt-6-sol" },
        attempts: 1,
        runTimeMs: expect.any(Number),
        model: "anthropic/claude-opus-5-5",
      },
      expect.objectContaining({ arm: "poteto", cardId: rerun.id, outcome: "running" }),
    ]);
  });

  it("archives a probe that stops with questions and removes its node worktree", async () => {
    const source = await importedSource();
    const { store, card, repos, handoffs, warn, onReview } = source;
    const { card: probe } = await store.createNodeProbe(card.id, { arm: "base" });

    const worktree = await source.runProbe(
      probe,
      reply({
        outcome: "needs_input",
        summary: "Empty input handling is ambiguous",
        questions: ["Should empty input return [] or raise?"],
      }),
    );
    await handoffs.resume(warn);

    expect(warn).not.toHaveBeenCalled();
    expect(onReview).toHaveBeenCalledOnce();
    const archived = await store.get(probe.id);
    expect(archived?.metadata?.archivedAt).toEqual(expect.any(Number));
    expect(archived?.metadata?.automation?.target?.worktree?.handoff?.phase).toBe("questions");
    expect(archived?.metadata?.comments?.at(-1)?.body).toBe(
      "**Probe base:** needs_input. A probe gets no answers, so it is archived with this outcome; its node worktree is removed.",
    );
    expect(existsSync(worktree)).toBe(false);
    expect(git(repos.target.repoPath, "branch", "--list", `factory/${probe.id}`)).toBe("");
    expect((await store.probes({ of: card.id })).probes).toEqual([
      expect.objectContaining({ cardId: probe.id, outcome: "needs_input" }),
    ]);
  });

  it("archives a probe the operator moves to done once its verification settles, never publishing it", async () => {
    const source = await importedSource({ verifier: true });
    const { store, card, repos, handoffs, warn, github, verifier } = source;
    const { card: probe } = await store.createNodeProbe(card.id, { arm: "base" });
    await source.runProbe(probe);
    await handoffs.resume(warn);
    git(repos.hostRepo, "remote", "set-url", "origin", "git@github.com:acme/app.git");
    github.tokens.set("acme/app", "token-app");

    await store.move(probe.id, "done", undefined);
    await handoffs.resume(warn);
    expect((await store.get(probe.id))?.metadata?.archivedAt).toBeUndefined();

    verifier.running = false;
    verifier.history = reply(
      { verdict: "pass", summary: "All green.", findings: [] },
      "workboard-verification",
    );
    await handoffs.resume(warn);

    expect(warn).not.toHaveBeenCalled();
    const archived = await store.get(probe.id);
    expect(archived?.status).toBe("done");
    expect(archived?.metadata?.archivedAt).toEqual(expect.any(Number));
    expect(archived?.metadata?.automation?.target?.worktree?.handoff?.phase).toBe("imported");
    expect(archived?.metadata?.comments?.at(-1)?.body).toBe(
      "**Probe base:** done, verification pass (openai/gpt-6-sol), 0 findings. Archived; it is never published.\n\nAll green.",
    );
    expect(github.requests).toEqual([]);
  });

  it("fetches a commit base that no origin branch holds anymore before creating the worktree", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "workboard-probe-"));
    roots.push(root);
    const repos = createNodeRepos(root);
    // A force-pushed main leaves a past ticket's base reachable only by its id.
    git(repos.origin, "checkout", "-q", "-b", "gone");
    git(repos.origin, "commit", "-q", "--allow-empty", "-m", "force-pushed away");
    const gone = git(repos.origin, "rev-parse", "HEAD");
    git(repos.origin, "checkout", "-q", "main");
    git(repos.origin, "branch", "-q", "-D", "gone");
    const store = createWorkboardSqliteTestStore();

    const { card } = await startNodeCard(store, createLocalNodeGateway(), {
      ...repos.target,
      baseRef: gone,
    });

    const worktree = (await store.get(card.id))?.metadata?.automation?.target?.worktree;
    expect(worktree?.baseCommit).toBe(gone);
    expect(git(worktree?.path ?? "", "rev-parse", "HEAD")).toBe(gone);
  });
});
