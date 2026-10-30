// Workboard tests cover merging agent-accepted rung c PRs one at a time, halted by a red base branch.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import type { WorkboardCard } from "@openclaw/workboard-contract";
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

describe("runAutoMergeQueue order", () => {
  it("merges the oldest mergeable PR only, passing over one whose checks failed", async () => {
    const github = createFakeGitHub("/unused");
    github.tokens.set("acme/app", "token-app");
    const hostRepoPath = mkdtempSync(path.join(os.tmpdir(), "workboard-auto-merge-"));
    roots.push(hostRepoPath);
    git(hostRepoPath, "init", "-q");
    git(hostRepoPath, "remote", "add", "origin", "git@github.com:acme/app.git");
    const cards = [9, 8, 7].map((number, index) => {
      const url = `https://github.com/acme/app/pull/${number}`;
      github.openPulls.push(url);
      github.queue.pullHeads.set(url, `head-${number}`);
      github.queue.pullChecks.set(url, number === 9 ? "FAILURE" : "SUCCESS");
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
                  publishedAt: index,
                  pullRequestUrl: url,
                  pullRequest: { state: "open", checkedAt: 0 },
                },
                reviews: [{ round: 0, verdict: "accept", decidedBy: "agent", rung: "c" }],
              },
            },
          },
        },
      } satisfies WorkboardCard;
    });
    const store = { recordAutoMerge: vi.fn(async () => undefined), setAutoMergeWait: vi.fn() };

    await runAutoMergeQueue({ store, github: github.access, cards, now: () => 1, warn: vi.fn() });

    expect(store.setAutoMergeWait).toHaveBeenCalledWith(
      "card-9",
      expect.objectContaining({ reason: "checks_failed" }),
    );
    expect(github.merges.map((merge) => merge.url)).toEqual(["https://github.com/acme/app/pull/8"]);
  });
});
