// Workboard tests cover merging agent-accepted rung c PRs one at a time, halted by a red base branch.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import type { WorkboardAutoMergeWaitRecord, WorkboardCard } from "@openclaw/workboard-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { redactOperatorCard } from "./card-redaction.js";
import { runAutoMergeQueue } from "./node-ticket-auto-merge.js";
import { PULL_REQUEST_SYNC_INTERVAL_MS } from "./node-ticket-pr-state.js";
import {
  createFakeGitHub,
  finishNodeTicket,
  git,
  postVerdict,
  removeTempRoots,
} from "./node-ticket.test-support.js";
import { projectWorkboardOverview } from "./overview.js";
import { createWorkboardTools } from "./tools.js";

const roots: string[] = [];

afterEach(() => {
  removeTempRoots();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const PR = "https://github.com/acme/app/pull/7";

/** A docs ticket at `rung` an agent accepted, with its ready PR open on GitHub. */
async function acceptedTicket(rung: "b" | "c") {
  let clock = Date.now();
  const ticket = await finishNodeTicket({ now: () => clock, docsRung: rung });
  await ticket.handoffs.resume(ticket.warn);
  await postVerdict(ticket.store, ticket.card.id);
  git(ticket.repos.hostRepo, "remote", "set-url", "origin", "git@github.com:acme/app.git");
  ticket.github.tokens.set("acme/app", "token-app");
  const move = expectDefined(
    createWorkboardTools({ store: ticket.store, context: { agentId: "dev" } }).find(
      (tool) => tool.name === "workboard_move",
    ),
    "workboard_move",
  );
  await move.execute("accept", { id: ticket.card.id, status: "done" });
  await ticket.handoffs.resume(ticket.warn);
  const handoff = async () => {
    const value = (await ticket.store.get(ticket.card.id))?.metadata?.automation?.target?.worktree
      ?.handoff;
    return value?.phase === "published" ? value : undefined;
  };
  const accepted = expectDefined((await handoff())?.headCommit, "published head");
  ticket.github.openPulls.push(PR);
  ticket.github.queue.pullHeads.set(PR, accepted);
  /** One handoff pass after the sync interval elapsed. */
  const syncPass = async () => {
    clock += PULL_REQUEST_SYNC_INTERVAL_MS;
    await ticket.handoffs.resume(ticket.warn);
  };
  const lastComment = async () =>
    (await ticket.store.get(ticket.card.id))?.metadata?.comments?.at(-1)?.body;
  return { ...ticket, accepted, handoff, syncPass, lastComment, now: () => clock };
}

describe("rung c auto-merge", () => {
  it("merges the accepted commit once its checks and the base branch are green, then keeps the sample", async () => {
    const ticket = await acceptedTicket("c");
    expect((await ticket.handoff())?.pullRequest?.state).toBe("open");

    // Pending checks hold the queue without a notice.
    ticket.github.queue.pullChecks.set(PR, "PENDING");
    await ticket.syncPass();
    expect(ticket.github.merges).toEqual([]);

    // A red base branch halts it, with one notice.
    ticket.github.queue.pullChecks.set(PR, "SUCCESS");
    ticket.github.queue.baseChecks = "FAILURE";
    await ticket.syncPass();
    await ticket.syncPass();
    expect(ticket.github.merges).toEqual([]);
    expect((await ticket.handoff())?.pullRequest?.autoMergeWait).toEqual({
      reason: "base_red",
      since: expect.any(Number),
    });
    const notices = (await ticket.store.get(ticket.card.id))?.metadata?.comments?.filter(
      (comment) => comment.body.startsWith("**Auto-merge waits:**"),
    );
    expect(notices).toHaveLength(1);

    ticket.github.queue.baseChecks = "SUCCESS";
    await ticket.syncPass();

    expect(ticket.warn).not.toHaveBeenCalled();
    const merge = expectDefined(ticket.github.merges[0], "merge");
    expect(ticket.github.merges).toHaveLength(1);
    expect(
      ticket.github.requests.find((request) => request.url.endsWith("/pulls/7/merge")),
    ).toMatchObject({
      method: "PUT",
      auth: "Bearer token-app",
      body: { merge_method: "merge", sha: ticket.accepted },
    });
    const pullRequest = (await ticket.handoff())?.pullRequest;
    expect(pullRequest).toEqual({
      state: "merged",
      checkedAt: expect.any(Number),
      mergedAt: expect.any(Number),
      mergeCommit: merge.sha,
      autoMerged: true,
    });
    expect(await ticket.lastComment()).toContain(
      `**Auto-merged** at rung c as ${merge.sha.slice(0, 7)}`,
    );
    expect((await ticket.store.mergeDigest({}, ticket.now())).classes).toEqual([
      {
        taskClass: "docs",
        merges: [
          expect.objectContaining({
            cardId: ticket.card.id,
            pullRequestUrl: PR,
            autoMerged: true,
            revertCommand: `git revert -m 1 ${merge.sha}`,
          }),
        ],
      },
    ]);

    // A sampled rung c PR stays on Needs you after its merge until it is read.
    const card = expectDefined(await ticket.store.get(ticket.card.id), "card");
    const reviews = card.metadata?.automation?.target?.worktree?.reviews ?? [];
    const sampled: WorkboardCard = structuredClone(card);
    sampled.metadata!.automation!.target!.worktree!.reviews = [
      ...reviews.slice(0, -1),
      { ...reviews.at(-1)!, sampled: true },
    ];
    expect(
      projectWorkboardOverview(
        [redactOperatorCard(sampled)],
        [{ id: "default" }],
        "default",
        ticket.now(),
      ).needsYou.map((entry) => [entry.cardId, entry.reason]),
    ).toEqual([[card.id, "sampled"]]);
  });

  it("passes over a PR whose head moved, and never merges a rung b accept", async () => {
    const moved = await acceptedTicket("c");
    moved.github.queue.pullChecks.set(PR, "SUCCESS");
    moved.github.queue.pullHeads.set(PR, "f".repeat(40));
    await moved.syncPass();
    expect(moved.github.merges).toEqual([]);
    expect(await moved.lastComment()).toContain("no longer the commit the agent accepted");

    const atB = await acceptedTicket("b");
    atB.github.queue.pullChecks.set(PR, "SUCCESS");
    await atB.syncPass();
    expect(atB.github.merges).toEqual([]);
    expect((await atB.handoff())?.pullRequest?.state).toBe("open");
  });
});

/** A fake GitHub with a host clone whose origin is acme/app, for queue runs without a store. */
function acmeQueue() {
  const github = createFakeGitHub("/unused");
  github.tokens.set("acme/app", "token-app");
  const hostRepoPath = mkdtempSync(path.join(os.tmpdir(), "workboard-auto-merge-"));
  roots.push(hostRepoPath);
  git(hostRepoPath, "init", "-q");
  git(hostRepoPath, "remote", "add", "origin", "git@github.com:acme/app.git");
  const store = { recordAutoMerge: vi.fn(async () => undefined), setAutoMergeWait: vi.fn() };
  const warn = vi.fn();
  /** An agent-accepted rung c card whose open PR `number` is on GitHub with green checks. */
  const candidate = (
    number: number,
    options: { publishedAt?: number; checks?: string; wait?: WorkboardAutoMergeWaitRecord } = {},
  ): WorkboardCard => {
    const url = `https://github.com/acme/app/pull/${number}`;
    github.openPulls.push(url);
    github.queue.pullHeads.set(url, `head-${number}`);
    github.queue.pullChecks.set(url, options.checks ?? "SUCCESS");
    return {
      id: `card-${number}`,
      title: `PR ${number}`,
      status: "done",
      priority: "normal",
      labels: ["class:docs"],
      position: 0,
      createdAt: 0,
      updatedAt: 0,
      metadata: {
        automation: {
          target: {
            kind: "node-claude",
            nodeId: "node",
            repoPath: "/repo",
            worktreesRoot: "/wt",
            hostRepoPath,
            worktree: {
              path: `/wt/${number}`,
              branch: `factory/${number}`,
              baseCommit: "a",
              rung: "c",
              handoff: {
                phase: "published",
                headCommit: `head-${number}`,
                importedAt: 0,
                publishedAt: options.publishedAt ?? number,
                pullRequestUrl: url,
                pullRequest: {
                  state: "open",
                  checkedAt: 0,
                  ...(options.wait ? { autoMergeWait: options.wait } : {}),
                },
              },
              reviews: [{ round: 0, verdict: "accept", decidedBy: "agent", rung: "c" }],
            },
          },
        },
      },
    };
  };
  const run = (cards: WorkboardCard[], heldPaths?: string[]) =>
    runAutoMergeQueue({
      store,
      github: github.access,
      cards,
      boards: [{ id: "default", ...(heldPaths ? { orchestration: { heldPaths } } : {}) }],
      now: () => 1,
      warn,
    });
  const fileReads = () =>
    github.requests.filter((request) => request.url.includes("/files?")).length;
  return { github, store, warn, candidate, run, fileReads };
}

describe("runAutoMergeQueue order", () => {
  it("merges the oldest mergeable PR only, passing over one whose checks failed", async () => {
    const queue = acmeQueue();
    const cards = [
      queue.candidate(9, { publishedAt: 0, checks: "FAILURE" }),
      queue.candidate(8, { publishedAt: 1 }),
      queue.candidate(7, { publishedAt: 2 }),
    ];

    await queue.run(cards);

    expect(queue.store.setAutoMergeWait).toHaveBeenCalledWith(
      "card-9",
      expect.objectContaining({ wait: { reason: "checks_failed" } }),
    );
    expect(queue.github.merges.map((merge) => merge.url)).toEqual([
      "https://github.com/acme/app/pull/8",
    ]);
  });
});

describe("runAutoMergeQueue held paths", () => {
  const held = ["server/webapp/", "infra/deploy.yml", "migrations"];

  it("holds a PR that touches a held file, directory, rename side, or deletion, and merges the control", async () => {
    const queue = acmeQueue();
    const touching = {
      file: [{ filename: "infra/deploy.yml" }],
      directory: [{ filename: "server/webapp/x.py" }],
      bareDirectory: [{ filename: "migrations/0002_add.sql" }],
      renameSource: [{ filename: "docs/moved.md", previous_filename: "migrations/0001.sql" }],
      renameTarget: [{ filename: "server/webapp/new.py", previous_filename: "docs/old.md" }],
      deletion: [{ filename: "infra/deploy.yml" }],
    };
    const cards = Object.entries(touching).map(([name, files], index) => {
      const card = queue.candidate(index + 1, { publishedAt: index });
      queue.github.queue.pullFiles.set(`https://github.com/acme/app/pull/${index + 1}`, files);
      return { name, card };
    });
    const control = queue.candidate(50, { publishedAt: 50 });
    queue.github.queue.pullFiles.set("https://github.com/acme/app/pull/50", [
      { filename: "server/webapp2/x.py" },
      { filename: "infra/deploy.yml.bak" },
      { filename: "migrations2/0001.sql" },
      { filename: "docs/migrations" },
    ]);

    await queue.run([...cards.map((entry) => entry.card), control], held);

    expect(queue.github.merges.map((merge) => merge.url)).toEqual([
      "https://github.com/acme/app/pull/50",
    ]);
    const waits = queue.store.setAutoMergeWait.mock.calls.map(([id, input]) => [id, input.wait]);
    expect(waits).toEqual([
      ["card-1", { reason: "held_path", headCommit: "head-1", paths: ["infra/deploy.yml"] }],
      ["card-2", { reason: "held_path", headCommit: "head-2", paths: ["server/webapp/x.py"] }],
      ["card-3", { reason: "held_path", headCommit: "head-3", paths: ["migrations/0002_add.sql"] }],
      ["card-4", { reason: "held_path", headCommit: "head-4", paths: ["migrations/0001.sql"] }],
      ["card-5", { reason: "held_path", headCommit: "head-5", paths: ["server/webapp/new.py"] }],
      ["card-6", { reason: "held_path", headCommit: "head-6", paths: ["infra/deploy.yml"] }],
    ]);
    expect(queue.store.setAutoMergeWait.mock.calls[0]?.[1].notice).toContain(
      "touches a held path (`infra/deploy.yml`)",
    );
    expect(queue.warn).not.toHaveBeenCalled();
  });

  it("reads every page of a long file list, and holds without a record when the list fails or comes back short", async () => {
    const queue = acmeQueue();
    const paged = queue.candidate(1, { publishedAt: 0 });
    queue.github.queue.pullFiles.set("https://github.com/acme/app/pull/1", [
      ...Array.from({ length: 30 }, (_, index) => ({ filename: `docs/page-one-${index}.md` })),
      { filename: "server/webapp/late.py" },
    ]);
    const failing = queue.candidate(2, { publishedAt: 1 });
    const short = queue.candidate(3, { publishedAt: 2 });
    queue.github.queue.pullFiles.set("https://github.com/acme/app/pull/3", [
      { filename: "docs/a.md" },
    ]);
    queue.github.queue.pullChangedFiles.set("https://github.com/acme/app/pull/3", 2);

    queue.github.queue.failFiles = true;
    await queue.run([failing], held);
    queue.github.queue.failFiles = false;
    await queue.run([paged, short], held);

    expect(queue.github.merges).toEqual([]);
    expect(queue.store.setAutoMergeWait.mock.calls.map(([id, input]) => [id, input.wait])).toEqual([
      ["card-1", { reason: "held_path", headCommit: "head-1", paths: ["server/webapp/late.py"] }],
    ]);
    expect(queue.warn.mock.calls.map(([message]) => message)).toEqual([
      expect.stringMatching(/holds card-2: GitHub GET .*pulls\/2\/files.* returned 500/),
      expect.stringMatching(/holds card-3: GitHub listed 1 of the PR's 2 changed files/),
    ]);
  });

  it("keeps a held PR held without another read, and reads a new accepted head again", async () => {
    const queue = acmeQueue();
    const wait = { reason: "held_path", headCommit: "head-1", since: 0 } as const;
    const same = queue.candidate(1, { wait: { ...wait, paths: ["infra/deploy.yml"] } });
    queue.github.queue.pullFiles.set("https://github.com/acme/app/pull/1", [
      { filename: "infra/deploy.yml" },
    ]);
    await queue.run([same], held);
    expect(queue.fileReads()).toBe(0);
    expect(queue.github.merges).toEqual([]);
    expect(queue.store.setAutoMergeWait).not.toHaveBeenCalled();

    const rework = queue.candidate(2, {
      wait: { ...wait, headCommit: "head-1-before-rework", paths: ["infra/deploy.yml"] },
    });
    queue.github.queue.pullFiles.set("https://github.com/acme/app/pull/2", [
      { filename: "docs/only.md" },
    ]);
    await queue.run([rework], held);
    expect(queue.fileReads()).toBe(1);
    expect(queue.github.merges.map((merge) => merge.url)).toEqual([
      "https://github.com/acme/app/pull/2",
    ]);
  });

  it("never reads files on a board without held paths", async () => {
    const queue = acmeQueue();
    const card = queue.candidate(1);
    queue.github.queue.pullFiles.set("https://github.com/acme/app/pull/1", [
      { filename: "infra/deploy.yml" },
    ]);

    await queue.run([card]);

    expect(queue.fileReads()).toBe(0);
    expect(queue.github.merges).toHaveLength(1);
  });
});

describe("rung c auto-merge held paths", () => {
  it("parks the accepted PR for the operator until the PR state sync sees it merged by hand", async () => {
    const ticket = await acceptedTicket("c");
    await ticket.store.upsertBoard({
      id: "default",
      orchestration: { heldPaths: ["./docs//"] },
    });
    ticket.github.queue.pullChecks.set(PR, "SUCCESS");
    ticket.github.queue.pullFiles.set(PR, [{ filename: "docs/guide.md" }]);

    await ticket.syncPass();
    await ticket.syncPass();

    expect(ticket.github.merges).toEqual([]);
    expect(ticket.warn).not.toHaveBeenCalled();
    expect((await ticket.handoff())?.pullRequest).toEqual({
      state: "open",
      checkedAt: expect.any(Number),
      autoMergeWait: {
        reason: "held_path",
        since: expect.any(Number),
        headCommit: ticket.accepted,
        paths: ["docs/guide.md"],
      },
    });
    const notices = (await ticket.store.get(ticket.card.id))?.metadata?.comments?.filter(
      (comment) => comment.body.startsWith("**Auto-merge waits:**"),
    );
    expect(notices).toHaveLength(1);
    expect(notices?.[0]?.body).toContain("`docs/guide.md`");
    const card = expectDefined(await ticket.store.get(ticket.card.id), "card");
    const boards = (await ticket.store.listBoards()).boards;
    expect(
      projectWorkboardOverview([redactOperatorCard(card)], boards, "default", ticket.now())
        .needsYou,
    ).toEqual([
      expect.objectContaining({
        cardId: card.id,
        reason: "held_path",
        heldPaths: ["docs/guide.md"],
        pullRequestUrl: PR,
      }),
    ]);

    // The operator merges on GitHub; the next sync records it as a hand merge.
    ticket.github.openPulls.splice(ticket.github.openPulls.indexOf(PR), 1);
    ticket.github.closedPulls.unshift({ html_url: PR, sha: "b".repeat(40), merged: true });
    await ticket.syncPass();
    const pullRequest = (await ticket.handoff())?.pullRequest;
    expect(pullRequest).toMatchObject({ state: "merged", mergeCommit: "b".repeat(40) });
    expect(pullRequest).not.toHaveProperty("autoMerged");
    expect(pullRequest).not.toHaveProperty("autoMergeWait");
    expect(ticket.github.merges).toEqual([]);
  });
});
