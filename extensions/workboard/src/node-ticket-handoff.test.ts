// Workboard tests cover bringing a finished node ticket's branch back into the host clone.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import { syncWorkboardAgentEnded } from "./lifecycle-sync.js";
import { createNodeTicketHandoffs } from "./node-ticket-handoff.js";
import {
  createLocalNodeGateway,
  createNodeRepos,
  git,
  startNodeCard,
} from "./node-ticket.test-support.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const doneReport = [
  {
    role: "assistant",
    content: `Done.\n\n\`\`\`workboard-report\n${JSON.stringify({
      outcome: "done",
      summary: "Parser accepts empty input",
      proof: [{ command: "pytest", status: "passed" }],
    })}\n\`\`\``,
  },
];

/** Starts a node card on local repos and lets it commit `files` in its worktree. */
async function finishNodeTicket(params: {
  files?: Record<string, string>;
  uncommitted?: boolean;
  originCommits?: number;
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
    event: { runId, success: true, messages: doneReport },
    context: { runId, sessionKey },
  });
  const warn = vi.fn();
  const github = createFakeGitHub(repos.origin);
  const handoffs = createNodeTicketHandoffs({
    store,
    runtime: gateway,
    github: github.access,
    start: async (cardId) =>
      await dispatchAndStartWorkboardCards({
        store,
        subagent: { run: vi.fn() },
        nodeTickets: gateway,
        options: { cardId },
      }),
  });
  return { store, card, repos, worktree, handoffs, warn, gateway, github };
}

/** GitHub as the publish step sees it: a local remote for the push and a recorded REST API. */
function createFakeGitHub(remote: string) {
  const tokens = new Map<string, string>();
  const openPulls: string[] = [];
  const failComments = { value: false };
  const requests: Array<{ method: string; url: string; auth?: string; body?: unknown }> = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ method, url, auth: headers.get("authorization") ?? undefined, body });
    if (url.endsWith("/comments") && failComments.value) {
      return new Response(JSON.stringify({ message: "Resource not accessible" }), { status: 403 });
    }
    const reply = url.includes("/pulls?")
      ? openPulls.map((html_url) => ({ html_url, number: Number(html_url.split("/").at(-1)) }))
      : method === "POST"
        ? { html_url: "https://github.com/acme/app/pull/7" }
        : { default_branch: "main" };
    return new Response(JSON.stringify(reply), { status: method === "POST" ? 201 : 200 });
  });
  return {
    tokens,
    openPulls,
    failComments,
    requests,
    access: {
      token: (repo: string) => tokens.get(repo),
      fetch: fetchImpl as unknown as typeof fetch,
      remoteUrl: () => remote,
    },
  };
}

/** Imports the ticket, points the host clone at a GitHub origin, and accepts the card. */
async function acceptImportedTicket() {
  const ticket = await finishNodeTicket({});
  await ticket.handoffs.resume(ticket.warn);
  git(ticket.repos.hostRepo, "remote", "set-url", "origin", "git@github.com:acme/app.git");
  await ticket.store.move(ticket.card.id, "done", undefined);
  return ticket;
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
    expect(existsSync(worktree)).toBe(false);
    expect(existsSync(`${worktree}.bundle`)).toBe(false);
    expect(git(repos.target.repoPath, "branch", "--list", branch)).toBe("");
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
    const { store, card, repos, worktree, handoffs, warn, gateway } = await finishNodeTicket({});
    const branch = `factory/${card.id}`;
    const base = git(repos.target.repoPath, "rev-parse", "main");
    const head = git(worktree, "rev-parse", "HEAD");
    git(repos.hostRepo, "branch", branch, "main");
    await handoffs.resume(warn);
    expect((await store.get(card.id))?.status).toBe("blocked");

    git(repos.hostRepo, "branch", "-D", branch);
    const ready = await store.move(card.id, "ready", undefined);
    const rerun = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run: vi.fn() },
      nodeTickets: gateway,
      options: { now: ready.updatedAt, maxStarts: 1 },
    });
    const started = rerun.started[0];
    expect(started).toBeDefined();
    await syncWorkboardAgentEnded({
      store,
      event: { runId: started?.runId, success: true, messages: doneReport },
      context: { runId: started?.runId, sessionKey: started?.sessionKey },
    });
    await handoffs.resume(warn);

    const stored = await store.get(card.id);
    expect(stored?.status).toBe("review");
    expect(stored?.metadata?.proof?.at(-1)?.note).toBe(
      `Imported ${branch} ${base.slice(0, 12)}..${head.slice(0, 12)} into ${repos.hostRepo}`,
    );
    expect(git(repos.hostRepo, "rev-parse", branch)).toBe(head);
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

  it("reworks a published ticket on its PR branch, keeping a reviewer's commit", async () => {
    const { store, card, repos, worktree, handoffs, warn, github, gateway } =
      await acceptImportedTicket();
    const branch = `factory/${card.id}`;
    const pullRequestUrl = "https://github.com/acme/app/pull/7";
    github.tokens.set("acme/app", "token-app");
    await handoffs.resume(warn);
    github.openPulls.push(pullRequestUrl);
    const review = path.join(path.dirname(repos.origin), "review");
    git(repos.origin, "worktree", "add", "-q", review, branch);
    writeFileSync(path.join(review, "parser.py"), "reviewed\n");
    git(review, "commit", "-q", "-am", "review fixup");
    const reviewed = git(review, "rev-parse", "HEAD");
    git(repos.origin, "worktree", "remove", review);

    await store.move(card.id, "todo", undefined);
    await store.addComment(card.id, { body: "Rename the flag to --strict." });
    // The handoff sweep runs on every card change; let it fire while the
    // claimed card still carries its published worktree record.
    const request: typeof gateway.request = async (method, params) => {
      const argv = (params?.params as { command?: string[] } | undefined)?.command ?? [];
      if (argv.includes("worktree") && argv.includes("add")) {
        await handoffs.resume(warn);
      }
      return await gateway.request(method, params);
    };
    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run: vi.fn() },
      nodeTickets: { request },
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
    expect((await store.get(card.id))?.metadata?.automation?.target?.worktree?.rework).toEqual({
      round: 1,
      pullRequestUrl,
      acceptedAt: expect.any(Number),
      outsideCommits: 1,
    });
    // The first publish stays the acceptance while the rework round runs.
    expect((await store.trust({})).total).toMatchObject({ accepted: 1, reworkRounds: 1 });

    writeFileSync(path.join(worktree, "flags.py"), "strict\n");
    git(worktree, "add", "-A");
    git(worktree, "commit", "-q", "-m", "rename flag");
    const reworked = git(worktree, "rev-parse", "HEAD");
    const started = result.started[0];
    await syncWorkboardAgentEnded({
      store,
      event: { runId: started?.runId, success: true, messages: doneReport },
      context: { runId: started?.runId, sessionKey: started?.sessionKey },
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
    });
    const trust = await store.trust({});
    expect(trust.total).toMatchObject({
      tickets: 1,
      accepted: 1,
      cleanAccepted: 0,
      firstPass: 1,
      reworkRounds: 1,
      outsideCommits: 1,
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

    // The note itself never counts as the review comment.
    await store.move(card.id, "todo", undefined);
    await handoffs.resume(warn);
    const again = await store.get(card.id);
    expect(again?.status).toBe("backlog");
    expect(again?.metadata?.comments?.filter((comment) => comment.body === note)).toHaveLength(2);
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

  it("waits once for a free node-ticket slot and starts the rework when one frees", async () => {
    const { store, card, handoffs, warn, github } = await acceptImportedTicket();
    github.tokens.set("acme/app", "token-app");
    await handoffs.resume(warn);
    store.nodeTicketConcurrency = 1;
    const other = await startNodeCard(store);

    await store.addComment(card.id, { body: "Add a test." });
    await store.move(card.id, "todo", undefined);
    await handoffs.resume(warn);
    await handoffs.resume(warn);

    const waiting = await store.get(card.id);
    expect(waiting?.status).toBe("todo");
    expect(
      waiting?.metadata?.comments?.filter((comment) =>
        comment.body.startsWith("Rework round 1 waits for a node-ticket slot"),
      ),
    ).toHaveLength(1);

    await store.block(other.card.id, { reason: "node offline" }, null);
    await handoffs.resume(warn);

    expect(warn).not.toHaveBeenCalled();
    expect((await store.get(card.id))?.status).toBe("running");
  });

  it("refuses to rework an imported ticket before its draft PR exists", async () => {
    const { store, card, handoffs, warn, gateway } = await finishNodeTicket({});
    await handoffs.resume(warn);
    await store.move(card.id, "todo", undefined);

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run: vi.fn() },
      nodeTickets: gateway,
      options: { cardId: card.id, now: Date.now() },
    });

    expect(result.startFailures[0]?.error).toContain("has no draft PR yet");
    expect(gateway.respond).not.toHaveBeenLastCalledWith("sessions.create", expect.anything());
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
