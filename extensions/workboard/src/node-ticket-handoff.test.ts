// Workboard tests cover bringing a finished node ticket's branch back into the host clone.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorkboardCard } from "@openclaw/workboard-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import { syncWorkboardAgentEnded, type WorkboardLifecycleSessionReader } from "./lifecycle-sync.js";
import { createNodeTicketHandoffs } from "./node-ticket-handoff.js";
import { hostGit } from "./node-ticket.js";
import {
  createFakeGitHub,
  createLocalNodeGateway,
  createNodeRepos,
  git,
  startNodeCard,
  endedSession,
} from "./node-ticket.test-support.js";
import { cardRunId, cardSessionKey } from "./store-card-helpers.js";
import { workboardCardConsumesNodeTicketSlot } from "./store-constants.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";
import { createWorkboardTools } from "./tools.js";

vi.mock("./node-ticket.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./node-ticket.js")>();
  return { ...actual, hostGit: vi.fn(actual.hostGit) };
});
const { hostGit: actualHostGit } =
  await vi.importActual<typeof import("./node-ticket.js")>("./node-ticket.js");

const roots: string[] = [];

afterEach(() => {
  vi.mocked(hostGit).mockImplementation(actualHostGit);
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function reportMessages(report: Record<string, unknown>) {
  return [
    {
      role: "assistant",
      content: `Done.\n\n\`\`\`workboard-report\n${JSON.stringify(report)}\n\`\`\``,
    },
  ];
}

const doneReport = reportMessages({
  outcome: "done",
  summary: "Parser accepts empty input",
  proof: [{ command: "pytest", status: "passed" }],
});

const questionsReport = reportMessages({
  outcome: "needs_input",
  summary: "Empty input handling is ambiguous",
  questions: ["Should empty input return [] or raise? Default: return []."],
});

/** Starts a node card on local repos and lets it commit `files` in its worktree. */
async function finishNodeTicket(params: {
  files?: Record<string, string>;
  uncommitted?: boolean;
  originCommits?: number;
  messages?: unknown[];
  onReview?: (card: WorkboardCard) => Promise<void>;
  readSessions?: WorkboardLifecycleSessionReader;
}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "workboard-handoff-"));
  roots.push(root);
  const repos = createNodeRepos(root);
  for (let index = 0; index < (params.originCommits ?? 0); index += 1) {
    git(repos.origin, "commit", "-q", "--allow-empty", "-m", `merged ${index}`);
  }
  const store = createWorkboardSqliteTestStore();
  const gateway = createLocalNodeGateway();
  const { card, sessionKey, runId } = await startNodeCard(store, gateway, repos.target);
  const worktree = path.join(repos.target.worktreesRoot, `wb-${card.id}`);
  const files = Object.entries(params.files ?? { "parser.py": "ok\n" });
  for (const [name, body] of files) {
    writeFileSync(path.join(worktree, name), body);
  }
  if (files.length > 0 && !params.uncommitted) {
    git(worktree, "add", "-A");
    git(worktree, "commit", "-q", "-m", "fix parser");
  }
  await syncWorkboardAgentEnded({
    store,
    event: { runId, success: true, messages: params.messages ?? doneReport },
    context: { runId, sessionKey },
    readSessions: endedSession(),
  });
  const warn = vi.fn();
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
    ...(params.onReview ? { onReview: params.onReview } : {}),
    ...(params.readSessions ? { readSessions: params.readSessions } : {}),
  });
  // The handoff sweep runs on every card change, so it fires while a start
  // that claimed the card still carries the previous worktree record.
  const sweepingNodes = {
    request: (async (method, requestParams) => {
      const argv = (requestParams?.params as { command?: string[] } | undefined)?.command ?? [];
      if (argv.includes("worktree") && argv.includes("add")) {
        await handoffs.resume(warn);
      }
      return await gateway.request(method, requestParams);
    }) satisfies typeof gateway.request,
  };
  /** Re-runs the blocked card as an operator does; `work` is the session's turn. */
  const rerunDone = async (work?: () => void) => {
    const ready = await store.move(card.id, "ready", undefined);
    const { started } = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run: vi.fn() },
      nodeTickets: sweepingNodes,
      options: { now: ready.updatedAt, maxStarts: 1 },
    });
    expect(started[0]).toBeDefined();
    expect((await store.get(card.id))?.status).toBe("running");
    work?.();
    await syncWorkboardAgentEnded({
      store,
      event: { runId: started[0]?.runId, success: true, messages: doneReport },
      context: { runId: started[0]?.runId, sessionKey: started[0]?.sessionKey },
      readSessions: endedSession(),
    });
    await handoffs.resume(warn);
  };
  return {
    store,
    card,
    repos,
    worktree,
    handoffs,
    warn,
    gateway,
    github,
    rerunDone,
    sweepingNodes,
  };
}

/** GitHub as the publish step sees it: a local remote for the push and a recorded REST API. */
/** Imports the ticket, points the host clone at a GitHub origin, and accepts the card. */
async function acceptImportedTicket(params: { sourceUrl?: string; verdict?: string } = {}) {
  const ticket = await finishNodeTicket({});
  await ticket.handoffs.resume(ticket.warn);
  if (params.sourceUrl) {
    await ticket.store.update(ticket.card.id, { sourceUrl: params.sourceUrl });
  }
  if (params.verdict) {
    await ticket.store.addComment(ticket.card.id, { body: params.verdict }, undefined, "agent:dev");
  }
  git(ticket.repos.hostRepo, "remote", "set-url", "origin", "git@github.com:acme/app.git");
  await ticket.store.move(ticket.card.id, "done", undefined);
  return ticket;
}

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

describe("node ticket handoff", () => {
  it("imports the ticket branch into the host clone, cleans the node, and moves to review", async () => {
    const { store, card, repos, worktree, handoffs, warn } = await finishNodeTicket({});
    const branch = `factory/${card.id}`;
    const head = git(worktree, "rev-parse", "HEAD");
    const base = git(repos.target.repoPath, "rev-parse", "main");
    expect((await store.get(card.id))?.status).toBe("running");

    await handoffs.resume(warn);

    const stored = await store.get(card.id);
    expect(warn).not.toHaveBeenCalled();
    expect(stored?.status).toBe("review");
    expect(stored?.metadata?.claim).toBeUndefined();
    expect(stored?.metadata?.automation?.target?.worktree?.handoff).toMatchObject({
      phase: "imported",
      headCommit: head,
    });
    expect(stored?.metadata?.proof?.at(-1)).toMatchObject({
      label: "bundle import",
      status: "passed",
      note: `Imported ${branch} ${base.slice(0, 12)}..${head.slice(0, 12)} into ${repos.hostRepo}`,
    });
    expect(git(repos.hostRepo, "rev-parse", branch)).toBe(head);
    expect(stored?.metadata?.automation?.target?.worktree?.rounds).toEqual([
      {
        round: 0,
        changes: {
          from: base,
          to: head,
          files: [{ path: "parser.py", added: 1, deleted: 0 }],
          totals: { files: 1, added: 1, deleted: 0 },
        },
      },
    ]);
    expect(existsSync(worktree)).toBe(false);
    expect(existsSync(`${worktree}.bundle`)).toBe(false);
    expect(git(repos.target.repoPath, "branch", "--list", branch)).toBe("");
  });

  it("imports without a diffstat when git diff --numstat fails", async () => {
    const { store, card, repos, handoffs, warn } = await finishNodeTicket({});
    vi.mocked(hostGit).mockImplementation(async (repoPath, args, env) =>
      args.includes("--numstat")
        ? { code: 128, stdout: "", stderr: "fatal: bad revision" }
        : await actualHostGit(repoPath, args, env),
    );

    await handoffs.resume(warn);

    const stored = await store.get(card.id);
    expect(stored?.status).toBe("review");
    expect(git(repos.hostRepo, "rev-parse", `factory/${card.id}`)).toBeTruthy();
    expect(stored?.metadata?.automation?.target?.worktree?.rounds).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      `workboard could not record the changed files of card ${card.id}: fatal: bad revision`,
    );
  });

  it("bases the ticket on the fetched origin even when both clones are stale", async () => {
    const { store, card, repos, worktree, handoffs, warn } = await finishNodeTicket({
      originCommits: 1,
    });
    const originHead = git(repos.origin, "rev-parse", "main");
    expect(git(repos.hostRepo, "rev-parse", "origin/main")).not.toBe(originHead);

    await handoffs.resume(warn);

    const stored = await store.get(card.id);
    expect(stored?.status).toBe("review");
    expect(stored?.metadata?.automation?.target?.worktree?.baseCommit).toBe(originHead);
    expect(git(repos.hostRepo, "rev-parse", `factory/${card.id}~1`)).toBe(originHead);
    expect(existsSync(worktree)).toBe(false);
  });

  it("blocks the card and keeps the node worktree when work is uncommitted", async () => {
    const { store, card, repos, worktree, handoffs, warn } = await finishNodeTicket({
      uncommitted: true,
    });

    await handoffs.resume(warn);

    const stored = await store.get(card.id);
    expect(stored?.status).toBe("blocked");
    expect(stored?.metadata?.comments?.at(-1)?.body).toContain(
      "Bundle import failed: the node worktree",
    );
    expect(stored?.metadata?.comments?.at(-1)?.body).toContain("parser.py");
    expect(existsSync(worktree)).toBe(true);
    expect(git(repos.hostRepo, "branch", "--list", `factory/${card.id}`)).toBe("");
  });

  it("never moves a host branch that already points elsewhere", async () => {
    const { store, card, repos, worktree, handoffs, warn } = await finishNodeTicket({});
    const branch = `factory/${card.id}`;
    git(repos.hostRepo, "branch", branch, "main");
    const hostBefore = git(repos.hostRepo, "rev-parse", branch);

    await handoffs.resume(warn);

    const stored = await store.get(card.id);
    expect(stored?.status).toBe("blocked");
    expect(stored?.metadata?.comments?.at(-1)?.body).toContain(
      `the host clone already has ${branch} at ${hostBefore}`,
    );
    expect(git(repos.hostRepo, "rev-parse", branch)).toBe(hostBefore);
    expect(existsSync(worktree)).toBe(true);
  });

  it("imports from the original base when a blocked card is re-run without new commits", async () => {
    const { store, card, repos, worktree, handoffs, warn, rerunDone } = await finishNodeTicket({});
    const branch = `factory/${card.id}`;
    const base = git(repos.target.repoPath, "rev-parse", "main");
    const head = git(worktree, "rev-parse", "HEAD");
    git(repos.hostRepo, "branch", branch, "main");
    await handoffs.resume(warn);
    expect((await store.get(card.id))?.status).toBe("blocked");

    git(repos.hostRepo, "branch", "-D", branch);
    await rerunDone();

    const stored = await store.get(card.id);
    expect(stored?.status).toBe("review");
    expect(stored?.metadata?.proof?.at(-1)?.note).toBe(
      `Imported ${branch} ${base.slice(0, 12)}..${head.slice(0, 12)} into ${repos.hostRepo}`,
    );
    expect(git(repos.hostRepo, "rev-parse", branch)).toBe(head);
  });

  it("blocks a branch that fails git diff --check before review, then imports the fixed rerun", async () => {
    const { store, card, repos, worktree, handoffs, warn, rerunDone } = await finishNodeTicket({
      files: { "parser.py": "ok  \n" },
    });
    const branch = `factory/${card.id}`;
    const base = git(repos.target.repoPath, "rev-parse", "main");
    const head = git(worktree, "rev-parse", "HEAD");

    await handoffs.resume(warn);

    const blocked = await store.get(card.id);
    expect(blocked?.status).toBe("blocked");
    expect(blocked?.metadata?.proof?.at(-1)).toMatchObject({
      label: "import check",
      status: "failed",
      command: `git diff --check ${base.slice(0, 12)}..${head.slice(0, 12)}`,
      note: expect.stringContaining("parser.py:1: trailing whitespace."),
    });
    expect(blocked?.metadata?.comments?.at(-1)?.body).toMatch(
      /^Import check: `git diff --check [0-9a-f]{12}\.\.[0-9a-f]{12}` failed; fix it with a new commit in the same worktree, then re-run the card to import again\.\n```\nparser\.py:1: trailing whitespace\.\n\+ok *\n```$/,
    );
    expect(git(repos.hostRepo, "branch", "--list", branch)).toBe("");
    expect(existsSync(worktree)).toBe(true);

    let fixed = "";
    await rerunDone(() => {
      writeFileSync(path.join(worktree, "parser.py"), "ok\n");
      git(worktree, "commit", "-q", "-am", "strip trailing whitespace");
      fixed = git(worktree, "rev-parse", "HEAD");
    });

    expect((await store.get(card.id))?.status).toBe("review");
    expect(git(repos.hostRepo, "rev-parse", branch)).toBe(fixed);
  });

  it("blocks instead of dropping commits made on a detached HEAD", async () => {
    const { store, card, repos, worktree, handoffs, warn } = await finishNodeTicket({});
    git(worktree, "checkout", "-q", "--detach");
    writeFileSync(path.join(worktree, "later.py"), "later\n");
    git(worktree, "add", "-A");
    git(worktree, "commit", "-q", "-m", "later fix");

    await handoffs.resume(warn);

    const stored = await store.get(card.id);
    expect(stored?.status).toBe("blocked");
    expect(stored?.metadata?.comments?.at(-1)?.body).toContain(
      `is not on factory/${card.id} (HEAD is HEAD)`,
    );
    expect(existsSync(worktree)).toBe(true);
    expect(git(repos.hostRepo, "branch", "--list", `factory/${card.id}`)).toBe("");
  });

  it("blocks a done report whose branch has no commits", async () => {
    const { store, card, handoffs, warn } = await finishNodeTicket({ files: {} });

    await handoffs.resume(warn);

    const stored = await store.get(card.id);
    expect(stored?.status).toBe("blocked");
    expect(stored?.metadata?.comments?.at(-1)?.body).toMatch(
      /^Bundle import failed: node mac-factory failed `git .* bundle create .*`: .*empty bundle/,
    );
  });
});

/** Makes the next sessions.create fail, as a launch that dies after its worktree record was prepared. */
function failNextLaunch(gateway: ReturnType<typeof createLocalNodeGateway>) {
  const respond = gateway.respond.getMockImplementation();
  gateway.respond.mockImplementation((method, params) => {
    if (method === "sessions.create") {
      gateway.respond.mockImplementation(respond!);
      throw new Error("node went offline");
    }
    return respond!(method, params);
  });
}

/** Unblocks a card whose launch failed and starts it again the way an operator would. */
async function retryStart(
  store: Awaited<ReturnType<typeof finishNodeTicket>>["store"],
  gateway: ReturnType<typeof createLocalNodeGateway>,
  cardId: string,
) {
  expect((await store.get(cardId))?.status).toBe("blocked");
  await store.unblock(cardId);
  await dispatchAndStartWorkboardCards({
    store,
    subagent: { run: vi.fn() },
    nodeTickets: gateway,
    options: { cardId },
  });
  return gateway.respond.mock.calls.findLast(([method]) => method === "sessions.create")?.[1]
    ?.message as string | undefined;
}

describe("node ticket questions", () => {
  it("waits in review with the questions, then resumes the same session with dev's answer", async () => {
    const { store, card, repos, worktree, handoffs, warn, gateway } = await finishNodeTicket({
      messages: questionsReport,
    });
    const firstSession = gateway.respond.mock.calls.find(
      ([method]) => method === "sessions.create",
    )?.[1]?.key;

    await handoffs.resume(warn);

    const asked = await store.get(card.id);
    expect(asked?.status).toBe("review");
    expect(asked?.metadata?.claim).toBeUndefined();
    expect(asked?.metadata?.automation?.target?.worktree?.handoff).toMatchObject({
      phase: "questions",
    });
    expect(asked?.metadata?.comments?.at(-1)?.body).toContain(
      "**Needs input:** Empty input handling is ambiguous\n\n- Should empty input return [] or raise?",
    );
    expect(asked?.events?.some((event) => event.toStatus === "blocked")).toBe(false);
    expect(existsSync(worktree)).toBe(true);

    const devTools = new Map(
      createWorkboardTools({ store, context: { agentId: "dev" } }).map((tool) => [tool.name, tool]),
    );
    await devTools
      .get("workboard_comment")
      ?.execute("answer", { id: card.id, body: "Return []; the CLI treats it as no-op." });
    await store.move(card.id, "todo", undefined);
    await handoffs.resume(warn);

    expect(warn).not.toHaveBeenCalled();
    const resumed = await store.get(card.id);
    expect(resumed?.status).toBe("running");
    expect(resumed?.metadata?.automation?.target?.worktree).toMatchObject({
      path: worktree,
      questions: { rounds: 1, operatorAnswers: 0 },
    });
    const [, launch] =
      gateway.respond.mock.calls.findLast(([method]) => method === "sessions.create") ?? [];
    expect(launch).toMatchObject({ key: firstSession, cwd: worktree });
    expect(launch?.message).toContain("## Answers to your questions");
    expect(launch?.message).toContain("Return []; the CLI treats it as no-op.");
    expect(launch?.message).not.toContain("Review rework");

    await syncWorkboardAgentEnded({
      store,
      event: { runId: cardRunId(resumed!), success: true, messages: doneReport },
      context: { runId: cardRunId(resumed!), sessionKey: cardSessionKey(resumed!) },
      readSessions: endedSession(),
    });
    await handoffs.resume(warn);

    const imported = await store.get(card.id);
    expect(imported?.status).toBe("review");
    expect(imported?.metadata?.automation?.target?.worktree?.handoff).toMatchObject({
      phase: "imported",
    });
    expect(git(repos.hostRepo, "rev-parse", `factory/${card.id}`)).toBeTruthy();
  });

  it("keeps the answers in the brief when the resumed launch fails and is retried", async () => {
    const { store, card, handoffs, warn, gateway } = await finishNodeTicket({
      messages: questionsReport,
    });
    await handoffs.resume(warn);
    await store.addComment(card.id, { body: "Return []." }, undefined, "agent:dev");
    await store.move(card.id, "todo", undefined);
    failNextLaunch(gateway);
    await handoffs.resume(warn);

    const message = await retryStart(store, gateway, card.id);

    expect(message).toContain("## Answers to your questions");
    expect(message).toContain("Return [].");
    expect(message?.split("## Turn contract")[0]).not.toContain("node went offline");
    expect((await store.get(card.id))?.metadata?.automation?.target?.worktree?.questions).toEqual({
      rounds: 1,
      operatorAnswers: 0,
    });
  });

  it("keeps the worktree of an answered ticket whose start claimed it before the swap", async () => {
    const { store, card, worktree, handoffs, warn } = await finishNodeTicket({
      messages: questionsReport,
    });
    await handoffs.resume(warn);
    await store.addComment(card.id, { body: "Return []." }, undefined, "operator");
    await store.move(card.id, "todo", undefined);
    // A scheduled or exact start claims the card before it replaces the worktree record.
    await store.claim(card.id, { ownerId: "dispatcher" });

    await handoffs.resume(warn);

    expect(existsSync(worktree)).toBe(true);
    const stored = await store.get(card.id);
    expect(stored?.status).toBe("running");
    expect(stored?.metadata?.automation?.target?.worktree?.handoff).toMatchObject({
      phase: "questions",
    });
  });

  it("counts an operator's answer and bounces moves that carry no answer or skip to done", async () => {
    const { store, card, handoffs, warn } = await finishNodeTicket({ messages: questionsReport });
    await handoffs.resume(warn);

    const bodies = async () =>
      ((await store.get(card.id))?.metadata?.comments ?? []).map((comment) => comment.body);
    for (const attempt of [1, 2]) {
      await store.move(card.id, "done", undefined);
      await handoffs.resume(warn);
      expect((await store.get(card.id))?.status, `done move ${attempt}`).toBe("review");
    }
    const refusals = (await bodies()).filter((body) => body.startsWith("This ticket stopped"));
    expect(refusals).toEqual([
      "This ticket stopped with open questions, so there is nothing to publish yet. Answer them in a comment and move it to todo, or archive the card; its node worktree stays until removed by hand.",
    ]);

    for (const attempt of [1, 2]) {
      await store.move(card.id, "todo", undefined);
      await handoffs.resume(warn);
      expect((await store.get(card.id))?.status, `todo move ${attempt}`).toBe("review");
    }
    expect((await bodies()).filter((body) => body.startsWith("Moved to todo"))).toHaveLength(1);

    await store.addComment(card.id, { body: "Raise ValueError." }, undefined, "operator");
    await store.move(card.id, "todo", undefined);
    await handoffs.resume(warn);
    expect((await store.get(card.id))?.metadata?.automation?.target?.worktree?.questions).toEqual({
      rounds: 1,
      operatorAnswers: 1,
    });
  });
});

describe("node ticket draft PR", () => {
  it("pushes the accepted commit and opens one draft PR with the repo's token", async () => {
    const { store, card, repos, worktree, handoffs, warn, github } = await acceptImportedTicket();
    const branch = `factory/${card.id}`;
    const head = git(repos.hostRepo, "rev-parse", branch);
    github.tokens.set("acme/app", "token-app");

    await handoffs.resume(warn);

    const stored = await store.get(card.id);
    expect(warn).not.toHaveBeenCalled();
    expect(stored?.status).toBe("done");
    expect(stored?.metadata?.automation?.target?.worktree?.handoff).toMatchObject({
      phase: "published",
      headCommit: head,
      pullRequestUrl: "https://github.com/acme/app/pull/7",
    });
    expect(stored?.metadata?.proof?.at(-1)).toMatchObject({
      label: "draft PR",
      status: "passed",
      url: "https://github.com/acme/app/pull/7",
    });
    expect(git(repos.origin, "rev-parse", branch)).toBe(head);
    expect(existsSync(worktree)).toBe(false);
    expect(github.requests.at(-1)).toEqual({
      method: "POST",
      url: "https://api.github.com/repos/acme/app/pulls",
      auth: "Bearer token-app",
      body: expect.objectContaining({ head: branch, base: "main", draft: true }),
    });

    await handoffs.resume(warn);
    expect(github.requests.filter((request) => request.method === "POST")).toHaveLength(1);
    const trust = await store.trust({});
    expect(trust.classes).toEqual([
      expect.objectContaining({ taskClass: "unclassified", accepted: 1, cleanAccepted: 1 }),
    ]);
    expect(trust.weeks.at(-1)).toMatchObject({ accepted: 1, autonomous: 1 });
  });

  it("closes the card's source GitHub issue when the draft PR merges", async () => {
    const { card, handoffs, warn, github } = await acceptImportedTicket({
      sourceUrl: "https://github.com/acme/tracker/issues/41",
    });
    github.tokens.set("acme/app", "token-app");

    await handoffs.resume(warn);

    const opened = github.requests.find((request) => request.method === "POST");
    expect(opened?.body).toMatchObject({
      body: expect.stringContaining(`\n\nCloses acme/tracker#41\n\nWorkboard card \`${card.id}\``),
    });
  });

  it("wakes the board automation at review and scores dev's verdict on the publish", async () => {
    const onReview = vi.fn(async (_card: WorkboardCard) => {});
    const { store, card, repos, handoffs, warn, github } = await finishNodeTicket({ onReview });
    await handoffs.resume(warn);
    expect(onReview).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: card.id, status: "review" }),
    );

    git(repos.hostRepo, "remote", "set-url", "origin", "git@github.com:acme/app.git");
    github.tokens.set("acme/app", "token-app");
    // Only an agent's comment is a verdict; the operator's own note is not.
    await store.addComment(card.id, { body: "Verdict: rework: looks off" });
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 1000 });
    try {
      await store.addComment(card.id, { body: "Verdict: accept" }, undefined, "agent:dev");
      vi.advanceTimersByTime(1000);
      await store.move(card.id, "done", undefined);
      vi.advanceTimersByTime(1000);
      // A verdict after the operator's decision is too late to count.
      await store.addComment(card.id, { body: "Verdict: rework: late" }, undefined, "agent:dev");
    } finally {
      vi.useRealTimers();
    }
    await handoffs.resume(warn);

    expect(warn).not.toHaveBeenCalled();
    expect(onReview).toHaveBeenCalledOnce();
    const reviews = (await store.get(card.id))?.metadata?.automation?.target?.worktree?.reviews;
    expect(reviews).toEqual([
      {
        round: 0,
        verdict: "accept",
        importedAt: expect.any(Number),
        publishedAt: expect.any(Number),
      },
    ]);
    const review = reviews![0]!;
    const accepted = await store.trust({});
    expect(accepted.weeks.findLast((week) => week.accepted > 0)?.medianReviewWaitMs).toBe(
      review.publishedAt! - review.importedAt!,
    );
    expect(accepted.total).toMatchObject({
      verdictRounds: 1,
      verdictAgreedRounds: 1,
      verdictCards: 1,
      verdictAgreedCards: 1,
    });

    // The late verdict landed after the publish, yet is no review feedback.
    await store.move(card.id, "todo", undefined);
    await handoffs.resume(warn);
    expect((await store.get(card.id))?.status).toBe("backlog");
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
    expect(verifier.creates).toEqual([
      expect.objectContaining({
        key: `agent:verifier:verify-${card.id.slice(0, 8)}-r0`,
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
      sessionKey: `agent:verifier:verify-${card.id.slice(0, 8)}-r0`,
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
      sessionKey: `agent:verifier:verify-${card.id.slice(0, 8)}-r0`,
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

    // The operator's re-run drops the result; the next pass verifies the round again.
    await store.dropNodeVerification(card.id);
    verifier.history = verificationReply({ verdict: "pass", summary: "all green" });
    await handoffs.resume(warn);
    expect(verifier.creates).toHaveLength(2);
    await expect(ticket.verificationOf()).resolves.toMatchObject({ phase: "running" });
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
      sessionKey: `agent:verifier:verify-${card.id.slice(0, 8)}-r0`,
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
    await store.move(card.id, "done", undefined);
    await handoffs.resume(warn);
    expect((await store.get(card.id))?.metadata?.automation?.target?.worktree?.reviews).toEqual([
      expect.objectContaining({
        round: 0,
        verdict: "missed",
        verification: { verdict: "error", model: "openai/gpt-6-sol" },
      }),
    ]);
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
    expect(boardReads).toHaveBeenCalledTimes(1);
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
    await decided.store.move(decided.card.id, "done", undefined);
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
    await store.move(card.id, "done", undefined);
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

  it("reworks a published ticket on its PR branch, keeping a reviewer's commit", async () => {
    const { store, card, repos, worktree, handoffs, warn, github, gateway, sweepingNodes } =
      await acceptImportedTicket({ verdict: "Verdict: rework: the flag name is unclear" });
    const branch = `factory/${card.id}`;
    const pullRequestUrl = "https://github.com/acme/app/pull/7";
    github.tokens.set("acme/app", "token-app");
    await handoffs.resume(warn);
    github.openPulls.push(pullRequestUrl);
    const review = path.join(path.dirname(repos.origin), "review");
    git(repos.origin, "worktree", "add", "-q", review, branch);
    // The import check covers only the round's own commits, not the reviewer's.
    writeFileSync(path.join(review, "parser.py"), "reviewed  \n");
    git(review, "commit", "-q", "-am", "review fixup");
    const reviewed = git(review, "rev-parse", "HEAD");
    git(repos.origin, "worktree", "remove", review);

    await store.move(card.id, "todo", undefined);
    await store.addComment(card.id, { body: "Rename the flag to --strict." });
    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run: vi.fn() },
      nodeTickets: sweepingNodes,
      options: { cardId: card.id, now: Date.now() },
    });

    expect(result.startFailures).toEqual([]);
    expect((await store.get(card.id))?.status).toBe("running");
    expect(git(worktree, "rev-parse", "HEAD")).toBe(reviewed);
    expect(gateway.respond).toHaveBeenLastCalledWith(
      "sessions.create",
      expect.objectContaining({
        message: expect.stringMatching(
          /Review rework, round 1[\s\S]*pull\/7[\s\S]*Rename the flag to --strict\./,
        ),
      }),
    );
    expect(gateway.respond.mock.lastCall?.[1]?.message).toContain(
      `make \`git diff --check ${reviewed}..HEAD\` pass`,
    );
    expect((await store.get(card.id))?.metadata?.automation?.target?.worktree?.rework).toEqual({
      round: 1,
      pullRequestUrl,
      acceptedAt: expect.any(Number),
      outsideCommits: 1,
      startCommit: reviewed,
    });
    // The first publish stays the acceptance while the rework round runs, and
    // dev's rework verdict on it matched the operator's reopen.
    expect((await store.trust({})).total).toMatchObject({
      accepted: 1,
      reworkRounds: 1,
      verdictRounds: 1,
      verdictAgreedRounds: 1,
      verdictCards: 1,
      verdictAgreedCards: 1,
      verdictMissed: 0,
    });

    writeFileSync(path.join(worktree, "flags.py"), "strict\n");
    git(worktree, "add", "-A");
    git(worktree, "commit", "-q", "-m", "rename flag");
    const reworked = git(worktree, "rev-parse", "HEAD");
    const started = result.started[0];
    const decision = {
      phase: "fix",
      decision: "Rename the flag to --strict",
      evidence: "flags.py:1",
    };
    await syncWorkboardAgentEnded({
      store,
      event: {
        runId: started?.runId,
        success: true,
        messages: reportMessages({
          outcome: "done",
          summary: "Parser accepts empty input",
          proof: [{ command: "pytest", status: "passed" }],
          decisions: [decision],
        }),
      },
      context: { runId: started?.runId, sessionKey: started?.sessionKey },
      readSessions: endedSession(),
    });
    await handoffs.resume(warn);
    expect((await store.get(card.id))?.status).toBe("review");
    expect(git(repos.hostRepo, "rev-parse", branch)).toBe(reworked);

    await store.move(card.id, "done", undefined);
    await handoffs.resume(warn);

    expect(warn).not.toHaveBeenCalled();
    expect(git(repos.origin, "rev-parse", branch)).toBe(reworked);
    // The reused PR keeps the first round's body, so each rework round is told as a PR comment.
    const posts = github.requests.filter((call) => call.method === "POST");
    expect(posts).toHaveLength(2);
    expect(posts[1]).toMatchObject({
      url: "https://api.github.com/repos/acme/app/issues/7/comments",
      auth: "Bearer token-app",
      body: { body: expect.any(String) },
    });
    const comment = (posts[1]?.body as { body: string } | undefined)?.body ?? "";
    expect(comment).toContain(`Rework round 1 pushed \`${reworked.slice(0, 12)}\``);
    expect(comment).toContain("1 commit pushed by others");
    expect(comment).toMatch(/> Rename the flag to --strict\.[\s\S]*> Parser accepts empty input/);
    expect((await store.get(card.id))?.metadata?.automation?.target?.worktree).toMatchObject({
      handoff: { phase: "published", headCommit: reworked, pullRequestUrl },
      rework: { round: 1, outsideCommits: 1 },
      reviews: [
        { round: 0, verdict: "rework" },
        { round: 1, verdict: "missed" },
      ],
      // Round 1 answers for its own commit, not the reviewer's parser.py fixup.
      rounds: [
        { round: 0, changes: { files: [{ path: "parser.py", added: 1, deleted: 0 }] } },
        {
          round: 1,
          decisions: [decision],
          changes: {
            from: reviewed,
            to: reworked,
            files: [{ path: "flags.py", added: 1, deleted: 0 }],
            totals: { files: 1, added: 1, deleted: 0 },
          },
        },
      ],
    });
    const trust = await store.trust({});
    expect(trust.total).toMatchObject({
      tickets: 1,
      accepted: 1,
      cleanAccepted: 0,
      firstPass: 1,
      reworkRounds: 1,
      outsideCommits: 1,
      // The second round went to done before any verdict: counted, not scored.
      verdictRounds: 1,
      verdictAgreedRounds: 1,
      verdictCards: 0,
      verdictMissed: 1,
    });
    expect(trust.weeks.at(-1)).toMatchObject({ accepted: 1, autonomous: 0 });

    // Once the PR branch is gone from origin, the node's earlier remote ref must not revive it.
    git(repos.origin, "branch", "-D", branch);
    await store.move(card.id, "todo", undefined);
    const gone = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run: vi.fn() },
      nodeTickets: gateway,
      options: { cardId: card.id, now: Date.now() },
    });
    expect(gone.startFailures[0]?.error).toContain("is no longer on origin");
  });

  it("records a rework round that only merged main as unchanged, so trust counts no rework", async () => {
    const { store, card, repos, worktree, handoffs, warn, github, gateway } =
      await acceptImportedTicket();
    github.tokens.set("acme/app", "token-app");
    await handoffs.resume(warn);
    github.openPulls.push("https://github.com/acme/app/pull/7");
    // Main moved under the PR, so the round's only commit merges it to clear the conflict.
    git(repos.origin, "commit", "-q", "--allow-empty", "-m", "main moved");
    await store.move(card.id, "todo", undefined);
    await store.addComment(card.id, { body: "Resolve the conflict with main." });
    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run: vi.fn() },
      nodeTickets: gateway,
      options: { cardId: card.id, now: Date.now() },
    });
    git(worktree, "merge", "-q", "--no-ff", "-m", "Merge origin/main", "origin/main");
    const { runId, sessionKey } = result.started[0] ?? {};
    await syncWorkboardAgentEnded({
      store,
      event: { runId, success: true, messages: doneReport },
      context: { runId, sessionKey },
      readSessions: endedSession(),
    });
    await handoffs.resume(warn);

    const stored = await store.get(card.id);
    expect(stored?.status).toBe("review");
    expect(stored?.metadata?.automation?.target?.worktree?.rework?.unchangedRounds).toEqual([1]);
    expect((await store.trust({})).total).toMatchObject({ cleanAccepted: 1, reworkRounds: 0 });
  });

  it("keeps a rework publish and says so on the card when the PR comment fails", async () => {
    const { store, card, repos, worktree, handoffs, warn, github, gateway } =
      await acceptImportedTicket();
    const branch = `factory/${card.id}`;
    github.tokens.set("acme/app", "token-app");
    await handoffs.resume(warn);
    github.openPulls.push("https://github.com/acme/app/pull/7");
    await store.move(card.id, "todo", undefined);
    await store.addComment(card.id, { body: "Add a test." });
    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run: vi.fn() },
      nodeTickets: gateway,
      options: { cardId: card.id, now: Date.now() },
    });
    writeFileSync(path.join(worktree, "test_parser.py"), "test\n");
    git(worktree, "add", "-A");
    git(worktree, "commit", "-q", "-m", "add test");
    const started = result.started[0];
    await syncWorkboardAgentEnded({
      store,
      event: { runId: started?.runId, success: true, messages: doneReport },
      context: { runId: started?.runId, sessionKey: started?.sessionKey },
      readSessions: endedSession(),
    });
    await handoffs.resume(warn);
    await store.move(card.id, "done", undefined);
    github.failComments.value = true;

    await handoffs.resume(warn);

    const stored = await store.get(card.id);
    expect(warn).not.toHaveBeenCalled();
    expect(stored?.status).toBe("done");
    expect(stored?.metadata?.automation?.target?.worktree?.handoff).toMatchObject({
      phase: "published",
      headCommit: git(repos.hostRepo, "rev-parse", branch),
    });
    expect(stored?.metadata?.comments?.at(-1)?.body).toContain(
      "Rework round 1 was pushed to https://github.com/acme/app/pull/7, but its PR comment failed: GitHub POST /repos/acme/app/issues/7/comments returned 403",
    );

    // Workboard's own failure note is not review feedback for round 2.
    await store.move(card.id, "todo", undefined);
    await handoffs.resume(warn);
    expect((await store.get(card.id))?.status).toBe("backlog");
  });

  it("starts the rework round when a published ticket is reopened with a review comment", async () => {
    const { store, card, handoffs, warn, github, gateway } = await acceptImportedTicket();
    github.tokens.set("acme/app", "token-app");
    await handoffs.resume(warn);
    github.openPulls.push("https://github.com/acme/app/pull/7");
    // Longer than the worker context's 400-char comment preview.
    const review = `Rename the flag to --strict. ${"Check each renamed call site. ".repeat(20)}Then update the README.`;

    await store.addComment(card.id, { body: review });
    await store.move(card.id, "todo", undefined);
    await handoffs.resume(warn);

    expect(warn).not.toHaveBeenCalled();
    const stored = await store.get(card.id);
    expect(stored?.status).toBe("running");
    expect(stored?.metadata?.automation?.target?.worktree?.rework).toMatchObject({ round: 1 });
    expect(gateway.respond).toHaveBeenLastCalledWith(
      "sessions.create",
      expect.objectContaining({
        message: expect.stringContaining("Review rework, round 1"),
      }),
    );
    const message = gateway.respond.mock.calls.findLast(
      ([method]) => method === "sessions.create",
    )?.[1]?.message;
    expect(message).toContain(review);
  });

  it("keeps the review feedback in the brief when the rework launch fails and is retried", async () => {
    const { store, card, handoffs, warn, github, gateway } = await acceptImportedTicket();
    github.tokens.set("acme/app", "token-app");
    await handoffs.resume(warn);
    github.openPulls.push("https://github.com/acme/app/pull/7");
    await store.addComment(
      card.id,
      { body: "Rename the flag to --strict." },
      undefined,
      "operator",
    );
    await store.move(card.id, "todo", undefined);
    failNextLaunch(gateway);
    await handoffs.resume(warn);

    const message = await retryStart(store, gateway, card.id);

    expect(message).toContain("Review rework, round 1");
    expect(message).toContain("### Review feedback");
    expect(message).toContain("Rename the flag to --strict.");
    expect(
      (await store.get(card.id))?.metadata?.automation?.target?.worktree?.rework,
    ).toMatchObject({ round: 1 });
  });

  it("refuses to queue a reopen without a review comment on a full pool", async () => {
    const { store, card, handoffs, warn, github, gateway } = await acceptImportedTicket();
    github.tokens.set("acme/app", "token-app");
    await handoffs.resume(warn);
    store.nodeTicketConcurrency = 1;
    await startNodeCard(store);
    await store.move(card.id, "todo", undefined);

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run: vi.fn() },
      nodeTickets: gateway,
      options: { cardId: card.id, queue: "request" },
    });

    expect(result.queued).toBeUndefined();
    expect(result.startFailures[0]?.error).toContain("node ticket slots are in use");
    expect((await store.get(card.id))?.metadata?.automation?.startRequest).toBeUndefined();
    await handoffs.resume(warn);
    expect((await store.get(card.id))?.status).toBe("backlog");
  });

  it("sends a reopen without a review comment back to backlog with the next step", async () => {
    const { store, card, handoffs, warn, github, gateway } = await acceptImportedTicket();
    github.tokens.set("acme/app", "token-app");
    await handoffs.resume(warn);
    const sessionsBefore = gateway.respond.mock.calls.filter(
      ([method]) => method === "sessions.create",
    );

    await store.move(card.id, "todo", undefined);
    await handoffs.resume(warn);
    await handoffs.resume(warn);

    const bounced = await store.get(card.id);
    expect(bounced?.status).toBe("backlog");
    const note =
      "Reopened without a review comment; add what should change and move it to todo again to start rework round 1.";
    expect(bounced?.metadata?.comments?.filter((comment) => comment.body === note)).toHaveLength(1);

    // The note itself never counts as the review comment, and it is posted once per round.
    await store.move(card.id, "todo", undefined);
    await handoffs.resume(warn);
    const again = await store.get(card.id);
    expect(again?.status).toBe("backlog");
    expect(again?.metadata?.comments?.filter((comment) => comment.body === note)).toHaveLength(1);
    // A scheduled dispatch pass never starts a reopen that lacks review feedback either.
    await store.move(card.id, "ready", undefined);
    const scheduled = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run: vi.fn() },
      nodeTickets: gateway,
    });
    expect(scheduled.started).toEqual([]);
    expect(
      gateway.respond.mock.calls.filter(([method]) => method === "sessions.create"),
    ).toHaveLength(sessionsBefore.length);
  });

  it("queues a reviewed reopen behind an older start request while the pool is full", async () => {
    const { store, card, handoffs, warn, github, gateway, repos } = await acceptImportedTicket();
    github.tokens.set("acme/app", "token-app");
    await handoffs.resume(warn);
    store.nodeTicketConcurrency = 1;
    const other = await startNodeCard(store);
    const older = await store.create({
      title: "Fix the lexer",
      status: "todo",
      metadata: { automation: { target: repos.target } },
    });
    const queued = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run: vi.fn() },
      nodeTickets: gateway,
      options: { cardId: older.id, queue: "request" },
    });
    const olderRequest = queued.queued?.metadata?.automation?.startRequest?.requestedAt ?? 0;
    expect(olderRequest).toBeGreaterThan(0);

    vi.useFakeTimers({ toFake: ["Date"], now: olderRequest + 1000 });
    try {
      await store.addComment(card.id, { body: "Add a test." });
      await store.move(card.id, "todo", undefined);
      await handoffs.resume(warn);
      await handoffs.resume(warn);
    } finally {
      vi.useRealTimers();
    }

    const waiting = await store.get(card.id);
    expect(waiting?.status).toBe("todo");
    expect(waiting?.metadata?.automation?.startRequest?.requestedAt).toBeGreaterThan(olderRequest);
    expect(
      waiting?.metadata?.comments?.filter((comment) =>
        comment.body.startsWith("Rework round 1 waits for a node-ticket slot"),
      ),
    ).toHaveLength(1);

    await store.block(other.card.id, { reason: "node offline" }, null);
    await handoffs.resume(warn);

    expect(warn).not.toHaveBeenCalled();
    expect((await store.get(older.id))?.status).toBe("running");
    expect((await store.get(card.id))?.status).toBe("todo");

    await store.block(older.id, { reason: "node offline" }, null);
    await handoffs.resume(warn);

    const started = await store.get(card.id);
    expect(started?.status).toBe("running");
    expect(started?.metadata?.automation?.startRequest).toBeUndefined();
  });

  it("refuses to rework an imported ticket before its draft PR exists", async () => {
    const { store, card, handoffs, warn, gateway } = await finishNodeTicket({});
    await handoffs.resume(warn);
    await expect(store.move(card.id, "todo", undefined)).rejects.toThrow("isn't published yet");

    await dispatchAndStartWorkboardCards({
      store,
      subagent: { run: vi.fn() },
      nodeTickets: gateway,
      options: { cardId: card.id, now: Date.now() },
    });

    expect((await store.get(card.id))?.status).toBe("review");
    expect(gateway.respond).not.toHaveBeenLastCalledWith("sessions.create", expect.anything());
  });

  it("finishes on the merged PR that already holds the accepted commit, without pushing or opening one", async () => {
    const { store, card, repos, handoffs, warn, github } = await acceptImportedTicket();
    const branch = `factory/${card.id}`;
    const head = git(repos.hostRepo, "rev-parse", branch);
    const mergedUrl = "https://github.com/acme/app/pull/134";
    github.tokens.set("acme/app", "token-app");
    github.closedPulls.push({ html_url: mergedUrl, sha: head, merged: true });

    await handoffs.resume(warn);

    const stored = await store.get(card.id);
    expect(stored?.status).toBe("done");
    expect(github.requests.filter((request) => request.method === "POST")).toEqual([]);
    expect(stored?.metadata?.automation?.target?.worktree?.handoff).toMatchObject({
      phase: "published",
      headCommit: head,
      pullRequestUrl: mergedUrl,
    });
    expect(stored?.metadata?.proof?.at(-1)).toMatchObject({ status: "passed", url: mergedUrl });
    expect(stored?.metadata?.comments?.at(-1)?.body).toBe(
      `${mergedUrl} already merged ${head.slice(0, 12)}, so no new PR was opened.`,
    );
    // GitHub may have deleted the merged branch; the publish must not revive it.
    expect(git(repos.origin, "branch", "--list", branch)).toBe("");
  });

  it("opens a new PR when no merged PR holds the accepted commit", async () => {
    const { store, card, repos, handoffs, warn, github } = await acceptImportedTicket();
    const head = git(repos.hostRepo, "rev-parse", `factory/${card.id}`);
    github.tokens.set("acme/app", "token-app");
    github.closedPulls.push(
      { html_url: "https://github.com/acme/app/pull/136", sha: head, merged: false },
      { html_url: "https://github.com/acme/app/pull/135", sha: "0".repeat(40), merged: true },
    );

    await handoffs.resume(warn);

    expect(
      (await store.get(card.id))?.metadata?.automation?.target?.worktree?.handoff,
    ).toMatchObject({ phase: "published", pullRequestUrl: "https://github.com/acme/app/pull/7" });
    expect(github.requests.at(-1)).toMatchObject({
      method: "POST",
      url: "https://api.github.com/repos/acme/app/pulls",
    });
  });

  it("blocks with GitHub's validation errors when the PR cannot be created", async () => {
    const { store, card, handoffs, warn, github } = await acceptImportedTicket();
    github.tokens.set("acme/app", "token-app");
    github.rejectCreate.value = {
      message: "Validation Failed",
      errors: [{ message: "No commits between main and factory/x" }],
    };

    await handoffs.resume(warn);

    const blocked = await store.get(card.id);
    expect(blocked?.status).toBe("blocked");
    expect(blocked?.metadata?.comments?.at(-1)?.body).toContain(
      "returned 422: Validation Failed: No commits between main and factory/x",
    );
  });

  it("blocks with the config step when the repo has no token, and retries on the next accept", async () => {
    const { store, card, repos, handoffs, warn, github } = await acceptImportedTicket();
    const branch = `factory/${card.id}`;

    await handoffs.resume(warn);

    const blocked = await store.get(card.id);
    expect(blocked?.status).toBe("blocked");
    expect(blocked?.metadata?.comments?.at(-1)?.body).toContain(
      'Draft PR failed: no GitHub token for acme/app; set plugins.entries.workboard.config.github.repos["acme/app"].token',
    );
    expect(github.requests).toEqual([]);
    expect(git(repos.origin, "branch", "--list", branch)).toBe("");

    github.tokens.set("acme/app", "token-app");
    github.openPulls.push("https://github.com/acme/app/pull/3");
    await store.move(card.id, "done", undefined);
    await handoffs.resume(warn);

    const stored = await store.get(card.id);
    expect(stored?.status).toBe("done");
    expect(stored?.metadata?.automation?.target?.worktree?.handoff).toMatchObject({
      phase: "published",
      pullRequestUrl: "https://github.com/acme/app/pull/3",
    });
    expect(github.requests.map((request) => request.method)).toEqual(["GET"]);
  });
});
