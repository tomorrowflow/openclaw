// Workboard tests cover syncing a published node ticket PR's GitHub state onto its card.
import { afterEach, describe, expect, it, vi } from "vitest";
import { workboardCardStage } from "./card-stage.js";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import { PULL_REQUEST_SYNC_INTERVAL_MS } from "./node-ticket-pr-state.js";
import { finishNodeTicket, git, postVerdict, removeTempRoots } from "./node-ticket.test-support.js";

afterEach(() => {
  removeTempRoots();
});

const PR = "https://github.com/acme/app/pull/7";

/** Publishes a node ticket's draft PR through the handoff pass on a clock the test moves. */
async function publishedTicket() {
  let clock = Date.now();
  const ticket = await finishNodeTicket({ now: () => clock });
  await ticket.handoffs.resume(ticket.warn);
  await postVerdict(ticket.store, ticket.card.id);
  git(ticket.repos.hostRepo, "remote", "set-url", "origin", "git@github.com:acme/app.git");
  ticket.github.tokens.set("acme/app", "token-app");
  await ticket.store.move(ticket.card.id, "done", undefined);
  await ticket.handoffs.resume(ticket.warn);
  const pullRequest = async () =>
    (await ticket.store.get(ticket.card.id))?.metadata?.automation?.target?.worktree?.handoff;
  const listCalls = () =>
    ticket.github.requests.filter((request) =>
      String((request.body as { query?: unknown } | undefined)?.query).includes("pullRequests("),
    );
  /** One handoff pass after the sync interval elapsed. */
  const syncPass = async () => {
    clock += PULL_REQUEST_SYNC_INTERVAL_MS;
    await ticket.handoffs.resume(ticket.warn);
  };
  return { ...ticket, pullRequest, listCalls, syncPass, now: () => clock };
}

describe("node ticket PR state sync", () => {
  it("records the publish's draft, then a merge with one list call, and stops reading a merged PR", async () => {
    const ticket = await publishedTicket();
    expect(await ticket.pullRequest()).toMatchObject({
      phase: "published",
      pullRequestUrl: PR,
      pullRequest: { state: "draft", checkedAt: ticket.now() },
    });
    // Passes inside the interval read nothing from GitHub.
    await ticket.handoffs.resume(ticket.warn);
    expect(ticket.listCalls()).toEqual([]);

    ticket.github.openPulls.push(PR);
    ticket.github.draftPulls.add(PR);
    const before = await ticket.store.get(ticket.card.id);
    await ticket.syncPass();
    expect(ticket.listCalls()).toHaveLength(1);
    expect(ticket.listCalls()[0]).toMatchObject({ method: "POST", auth: "Bearer token-app" });
    // An unchanged state writes nothing.
    expect((await ticket.store.get(ticket.card.id))?.updatedAt).toBe(before?.updatedAt);

    ticket.github.openPulls.splice(0);
    ticket.github.closedPulls.push({ html_url: PR, sha: "0".repeat(40), merged: true });
    await ticket.syncPass();
    const merged = await ticket.store.get(ticket.card.id);
    expect(ticket.warn).not.toHaveBeenCalled();
    expect(merged?.metadata?.automation?.target?.worktree?.handoff).toMatchObject({
      pullRequest: { state: "merged", checkedAt: ticket.now() },
    });
    expect(merged && workboardCardStage(merged)).toMatchObject({
      kind: "published",
      pullRequestUrl: PR,
      pullRequestState: "merged",
    });
    // The merge is a GitHub fact; the round's accept verdict stays as recorded.
    expect(merged?.metadata?.automation?.target?.worktree?.reviews?.at(-1)).toMatchObject({
      verdict: "accept",
    });

    await ticket.syncPass();
    expect(ticket.listCalls()).toHaveLength(2);
  });

  it("records a PR closed without merging and a draft marked ready", async () => {
    const ticket = await publishedTicket();
    ticket.github.openPulls.push(PR);
    await ticket.syncPass();
    expect(await ticket.pullRequest()).toMatchObject({ pullRequest: { state: "open" } });

    ticket.github.openPulls.splice(0);
    ticket.github.closedPulls.push({ html_url: PR, sha: "0".repeat(40), merged: false });
    await ticket.syncPass();
    expect(await ticket.pullRequest()).toMatchObject({ pullRequest: { state: "closed" } });
  });

  it("reopens a done ticket once when its PR conflicts with the base", async () => {
    const ticket = await publishedTicket();
    ticket.github.openPulls.push(PR);
    ticket.github.draftPulls.add(PR);
    ticket.github.conflictingPulls.add(PR);
    await ticket.syncPass();
    const reopened = await ticket.store.get(ticket.card.id);
    expect(reopened?.status).toBe("todo");
    expect(reopened?.metadata?.comments?.at(-1)?.body).toContain(
      `The draft PR ${PR} no longer merges into its base branch.`,
    );
    expect(await ticket.pullRequest()).toMatchObject({ conflictReworkAt: ticket.now() });

    // An operator who sends it back to done owns the conflict; the sync does not loop.
    await ticket.store.move(ticket.card.id, "done", undefined);
    await ticket.syncPass();
    expect((await ticket.store.get(ticket.card.id))?.status).toBe("done");
  });

  it("pages back through the repository's PRs to find an old one", async () => {
    const ticket = await publishedTicket();
    ticket.github.closedPulls.push(
      ...Array.from({ length: 150 }, (_, index) => ({
        html_url: `https://github.com/acme/app/pull/${1000 + index}`,
        sha: "0".repeat(40),
        merged: true,
      })),
      { html_url: PR, sha: "0".repeat(40), merged: true },
    );
    await ticket.syncPass();
    expect(
      ticket
        .listCalls()
        .map((request) => (request.body as { variables: { after: unknown } }).variables.after),
    ).toEqual([null, "100"]);
    expect(await ticket.pullRequest()).toMatchObject({ pullRequest: { state: "merged" } });
  });

  it("keeps the last known state and warns when GitHub refuses or the token is gone", async () => {
    const ticket = await publishedTicket();
    ticket.github.closedPulls.push({ html_url: PR, sha: "0".repeat(40), merged: true });
    ticket.github.failPullList.value = true;
    await ticket.syncPass();
    expect(ticket.warn).toHaveBeenLastCalledWith(
      expect.stringContaining("workboard PR state sync failed for acme/app: GitHub GraphQL"),
    );
    expect(ticket.warn).toHaveBeenLastCalledWith(
      expect.stringContaining("API rate limit exceeded"),
    );
    expect(await ticket.pullRequest()).toMatchObject({ pullRequest: { state: "draft" } });

    ticket.github.failPullList.value = false;
    ticket.github.tokens.clear();
    await ticket.syncPass();
    expect(ticket.warn).toHaveBeenLastCalledWith(
      expect.stringContaining("no GitHub token for acme/app"),
    );
    expect(await ticket.pullRequest()).toMatchObject({ pullRequest: { state: "draft" } });

    // The next pass after the cause is fixed catches up.
    ticket.github.tokens.set("acme/app", "token-app");
    await ticket.syncPass();
    expect(await ticket.pullRequest()).toMatchObject({ pullRequest: { state: "merged" } });
  });

  it("starts a child ticket only once its parent's PR merged", async () => {
    const ticket = await publishedTicket();
    const child = await ticket.store.create({
      title: "Use the parser",
      status: "ready",
      agentId: "dev",
      parents: [ticket.card.id],
      workspaceAccess: { unrestricted: true },
      metadata: { automation: { target: ticket.repos.target } },
    });
    const dispatch = async () =>
      await dispatchAndStartWorkboardCards({
        store: ticket.store,
        subagent: { run: vi.fn() },
        nodeTickets: ticket.gateway,
        options: { maxStarts: 1, now: ticket.now() },
      });

    // The parent is done, but its draft PR is not on the default branch the
    // child's worktree starts from: the scheduled pass queues the child.
    expect((await dispatch()).started).toEqual([]);
    const queued = await ticket.store.get(child.id);
    expect(queued?.status).toBe("ready");
    expect(queued && workboardCardStage(queued)).toMatchObject({ kind: "queued" });
    expect(queued?.metadata?.comments?.at(-1)?.body).toContain(
      `waits for its parents' PRs to merge: ${PR}.`,
    );
    await ticket.handoffs.resume(ticket.warn);
    expect((await ticket.store.get(child.id))?.status).toBe("ready");

    ticket.github.closedPulls.push({ html_url: PR, sha: "0".repeat(40), merged: true });
    await ticket.syncPass();
    await ticket.handoffs.resume(ticket.warn);
    expect(ticket.warn).not.toHaveBeenCalled();
    const started = await ticket.store.get(child.id);
    expect(started?.status).toBe("running");
    expect(started?.metadata?.automation?.startRequest).toBeUndefined();
  });
});
