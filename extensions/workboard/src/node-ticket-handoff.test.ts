// Workboard tests cover bringing a finished node ticket's branch back into the host clone.
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { WorkboardCard } from "@openclaw/workboard-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import { syncWorkboardAgentEnded } from "./lifecycle-sync.js";
import { hostGit } from "./node-ticket.js";
import {
  createLocalNodeGateway,
  doneReport,
  finishNodeTicket,
  git,
  moveDoneAfterReviewDeadline,
  postVerdict,
  questionsReport,
  removeTempRoots,
  reportMessages,
  startNodeCard,
  endedSession,
} from "./node-ticket.test-support.js";
import { cardRunId, cardSessionKey } from "./store-card-helpers.js";
import { createWorkboardTools } from "./tools.js";

vi.mock("./node-ticket.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./node-ticket.js")>();
  return { ...actual, hostGit: vi.fn(actual.hostGit) };
});
const { hostGit: actualHostGit } =
  await vi.importActual<typeof import("./node-ticket.js")>("./node-ticket.js");

afterEach(() => {
  vi.mocked(hostGit).mockImplementation(actualHostGit);
  removeTempRoots();
});

/** GitHub as the publish step sees it: a local remote for the push and a recorded REST API. */
/** Imports the ticket, points the host clone at a GitHub origin, and accepts the card. */
async function acceptImportedTicket(
  params: { sourceUrl?: string; verdict?: string; messages?: unknown[] } = {},
) {
  const ticket = await finishNodeTicket({ messages: params.messages });
  await ticket.handoffs.resume(ticket.warn);
  if (params.sourceUrl) {
    await ticket.store.update(ticket.card.id, { sourceUrl: params.sourceUrl });
  }
  await postVerdict(ticket.store, ticket.card.id, params.verdict);
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
    // No verifier on the board: nothing to wait for besides the verdict.
    expect(stored?.metadata?.automation?.target?.worktree?.handoff).not.toHaveProperty("verify");
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

  it("leads the draft PR body with the session's headline and folds in its decisions", async () => {
    const { handoffs, warn, github } = await acceptImportedTicket({
      messages: reportMessages({
        outcome: "done",
        headline: "Empty input now parses to no rows.",
        summary: "Parser accepts empty input",
        proof: [{ command: "pytest", status: "passed" }],
        decisions: [
          {
            phase: "build",
            decision: "Return [] for empty input",
            why: "the CLI pipes empty files",
            evidence: "parser.py:1",
          },
        ],
      }),
    });
    github.tokens.set("acme/app", "token-app");

    await handoffs.resume(warn);

    const body =
      (github.requests.find((request) => request.method === "POST")?.body as { body: string })
        ?.body ?? "";
    expect(body).toMatch(/^\*\*Summary:\*\* Empty input now parses to no rows\.\n\n/);
    expect(body).toContain(
      "<details><summary>Decisions this round (1)</summary>\n\n- **build:** Return [] for empty input Why: the CLI pipes empty files (parser.py:1)\n\n</details>",
    );
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
        verdictAt: expect.any(Number),
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

  it("marks the PR as not accepted when its round goes back for rework", async () => {
    const { store, card, handoffs, warn, github } = await acceptImportedTicket({
      verdict: "Verdict: rework: the flag name is unclear",
    });
    const pullRequestUrl = "https://github.com/acme/app/pull/7";
    github.tokens.set("acme/app", "token-app");
    await handoffs.resume(warn);
    github.openPulls.push(pullRequestUrl);
    github.pullTexts.set(pullRequestUrl, { title: card.title, body: "Fixes the parser." });

    await store.addComment(card.id, { body: "Rename the flag to --strict." });
    await store.move(card.id, "todo", undefined);
    await handoffs.resume(warn);
    await handoffs.resume(warn);

    expect(warn).not.toHaveBeenCalled();
    expect(github.requests.filter((request) => request.method === "PATCH")).toHaveLength(1);
    expect(github.pullTexts.get(pullRequestUrl)).toEqual({
      title: `[not accepted, rework round 1] ${card.title}`,
      body: "**Not accepted.** The Workboard sent round 0 back for rework; don't merge until the card is done again.\n\nFixes the parser.",
    });
  });

  it("starts the rework round with its feedback when the PR cannot be marked", async () => {
    const { store, card, handoffs, warn, github, gateway } = await acceptImportedTicket({
      verdict: "Verdict: rework: the flag name is unclear",
    });
    const pullRequestUrl = "https://github.com/acme/app/pull/7";
    github.tokens.set("acme/app", "token-app");
    await handoffs.resume(warn);
    github.openPulls.push(pullRequestUrl);
    github.failPullEdits.value = true;

    await store.addComment(card.id, { body: "Rename the flag to --strict." });
    await store.move(card.id, "todo", undefined);
    await handoffs.resume(warn);

    expect(warn).not.toHaveBeenCalled();
    const started = await store.get(card.id);
    expect(started?.status).toBe("running");
    expect(gateway.respond).toHaveBeenLastCalledWith(
      "sessions.create",
      expect.objectContaining({
        message: expect.stringContaining("Rename the flag to --strict."),
      }),
    );
    expect(started?.metadata?.comments?.at(-1)?.body).toMatch(
      /^Rework round 1 goes ahead, but https:\/\/github\.com\/acme\/app\/pull\/7 could not be marked as not accepted: GitHub PATCH \/repos\/acme\/app\/pulls\/7 returned 403/,
    );
  });

  it("takes the rework marker off the PR when a round is accepted", async () => {
    const { card, handoffs, warn, github } = await acceptImportedTicket();
    const pullRequestUrl = "https://github.com/acme/app/pull/7";
    github.tokens.set("acme/app", "token-app");
    github.openPulls.push(pullRequestUrl);
    github.pullTexts.set(pullRequestUrl, {
      title: `[not accepted, rework round 1] ${card.title}`,
      // Edited on github.com, so CRLF line ends.
      body: "**Not accepted.** The Workboard sent round 0 back for rework; don't merge until the card is done again.\r\n\r\nFixes the parser.",
    });

    await handoffs.resume(warn);

    expect(warn).not.toHaveBeenCalled();
    expect(github.pullTexts.get(pullRequestUrl)).toEqual({
      title: card.title,
      body: "Fixes the parser.",
    });
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

    // The round got no verdict, so it is decided after the readiness deadline.
    await moveDoneAfterReviewDeadline(store, card.id);
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
    expect(comment).toContain(
      "<summary>Decisions this round (1)</summary>\n\n- **fix:** Rename the flag to --strict (flags.py:1)",
    );
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
    await postVerdict(store, card.id);
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
    await postVerdict(store, card.id);
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
