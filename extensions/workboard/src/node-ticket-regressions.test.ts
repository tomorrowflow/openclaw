// Workboard tests cover watching a merged node ticket PR for a regression and moving its class back from rung c.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { PULL_REQUEST_SYNC_INTERVAL_MS } from "./node-ticket-pr-state.js";
import { mergeRegression, REGRESSION_WATCH_MS } from "./node-ticket-regressions.js";
import { finishNodeTicket, git, postVerdict, removeTempRoots } from "./node-ticket.test-support.js";
import { createWorkboardTools } from "./tools.js";
import { projectWorkboardTrust } from "./trust-kpis.js";

afterEach(() => {
  removeTempRoots();
});

const PR = "https://github.com/acme/app/pull/7";
const MERGE = "m".repeat(40);
const REVERT = "r".repeat(40);

/** A docs ticket at `rung` that an agent accepted, published, and GitHub merged. */
async function mergedTicket(rung: "b" | "c") {
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
  ticket.github.closedPulls.push({ html_url: PR, sha: MERGE, merged: true, mergedAt: clock });
  /** One handoff pass after the sync interval elapsed. */
  const syncPass = async () => {
    clock += PULL_REQUEST_SYNC_INTERVAL_MS;
    await ticket.handoffs.resume(ticket.warn);
  };
  await syncPass();
  const pullRequest = async () => {
    const handoff = (await ticket.store.get(ticket.card.id))?.metadata?.automation?.target?.worktree
      ?.handoff;
    return handoff?.phase === "published" ? handoff.pullRequest : undefined;
  };
  const docsRung = async () => (await ticket.store.boardOrchestration("default"))?.classRungs?.docs;
  const trust = async () =>
    projectWorkboardTrust(
      await ticket.store.list(),
      "default",
      clock,
      await ticket.store.boardOrchestration("default"),
    ).classes.find((entry) => entry.taskClass === "docs");
  const historyReads = () =>
    ticket.github.requests.filter((request) =>
      String((request.body as { query?: unknown } | undefined)?.query).includes("defaultBranchRef"),
    );
  return {
    ...ticket,
    syncPass,
    pullRequest,
    docsRung,
    trust,
    historyReads,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("merge regression watch", () => {
  it("records a revert of a rung c merge, moves the class back to b, and counts it until dismissed", async () => {
    const ticket = await mergedTicket("c");
    const mergedAt = expectDefined((await ticket.pullRequest())?.mergedAt, "mergedAt");
    expect(await ticket.pullRequest()).toEqual({
      state: "merged",
      checkedAt: expect.any(Number),
      mergedAt,
      mergeCommit: MERGE,
    });
    expect((await ticket.docsRung())?.rung).toBe("c");

    ticket.github.baseHistory.push(
      { oid: REVERT, message: `Revert "fix parser (#7)" (#9)\n\nThis reverts commit ${MERGE}.` },
      { oid: MERGE, message: "fix parser (#7)", checks: "SUCCESS", parentChecks: "SUCCESS" },
    );
    await ticket.syncPass();

    expect(ticket.warn).not.toHaveBeenCalled();
    expect((await ticket.pullRequest())?.regression).toEqual({
      kind: "revert",
      commit: REVERT,
      at: expect.any(Number),
      demoted: true,
    });
    expect(await ticket.docsRung()).toEqual({ rung: "b", since: expect.any(Number) });
    const comments = (await ticket.store.get(ticket.card.id))?.metadata?.comments ?? [];
    expect(comments.at(-1)?.body).toContain(
      "**Regression:** commit rrrrrrr on the base branch reverts this PR's merge.",
    );
    expect(comments.at(-1)?.body).toContain("Class docs moved from rung c to b (D37).");
    expect(await ticket.trust()).toMatchObject({
      regressions: 1,
      blind: { c: { regressions: 1 } },
    });

    // The recorded regression stands: later passes neither read for it nor post again.
    const reads = ticket.historyReads().length;
    await ticket.syncPass();
    expect(ticket.historyReads()).toHaveLength(reads);
    expect((await ticket.store.get(ticket.card.id))?.metadata?.comments).toHaveLength(
      comments.length,
    );

    await ticket.store.dismissMergeRegression(ticket.card.id);
    expect((await ticket.pullRequest())?.regression?.dismissedAt).toEqual(expect.any(Number));
    expect(await ticket.trust()).toMatchObject({
      regressions: 0,
      blind: { c: { regressions: 0 } },
    });
    expect((await ticket.docsRung())?.rung).toBe("b");
  });

  it("records a red merge commit at rung b without a demotion, and only against a green parent", async () => {
    const ticket = await mergedTicket("b");
    const merge = {
      oid: MERGE,
      message: "fix parser (#7)",
      checks: "FAILURE",
      parentChecks: "FAILURE",
    };
    ticket.github.baseHistory.push(merge);
    await ticket.syncPass();
    expect((await ticket.pullRequest())?.regression).toBeUndefined();

    merge.parentChecks = "SUCCESS";
    await ticket.syncPass();
    expect((await ticket.pullRequest())?.regression).toEqual({
      kind: "red_main",
      commit: MERGE,
      at: expect.any(Number),
    });
    expect((await ticket.docsRung())?.rung).toBe("b");
    const notice = (await ticket.store.get(ticket.card.id))?.metadata?.comments?.at(-1)?.body;
    expect(notice).toContain("failed its checks on the base branch");
    expect(notice).not.toContain("moved from rung c");
    expect(await ticket.trust()).toMatchObject({ regressions: 1 });
  });

  it("stops watching a merge 7 days after it merged", async () => {
    const ticket = await mergedTicket("c");
    // The merge's own pass already read the history once, finding nothing.
    expect(ticket.historyReads()).toHaveLength(1);
    ticket.advance(REGRESSION_WATCH_MS);
    ticket.github.baseHistory.push({
      oid: REVERT,
      message: `This reverts commit ${MERGE}.`,
    });
    await ticket.syncPass();
    expect(ticket.historyReads()).toHaveLength(1);
    expect((await ticket.pullRequest())?.regression).toBeUndefined();
    expect((await ticket.docsRung())?.rung).toBe("c");
  });

  it("refuses to dismiss a card with no recorded regression", async () => {
    const ticket = await mergedTicket("b");
    await expect(ticket.store.dismissMergeRegression(ticket.card.id)).rejects.toThrow(
      "only a merged node ticket PR with a recorded regression can be dismissed.",
    );
  });
});

describe("mergeRegression", () => {
  const merge = { mergeCommit: MERGE, number: 7 };

  it("reads a revert from git's line or GitHub's squash title, and only for this PR", () => {
    expect(
      mergeRegression(merge, [
        { oid: REVERT, message: `Revert x\n\nThis reverts commit ${MERGE}.` },
      ]),
    ).toEqual({ kind: "revert", commit: REVERT });
    expect(
      mergeRegression(merge, [{ oid: REVERT, message: 'Revert "fix parser (#7)" (#9)' }]),
    ).toEqual({ kind: "revert", commit: REVERT });
    expect(
      mergeRegression(merge, [{ oid: REVERT, message: 'Revert "other fix (#70)" (#71)' }]),
    ).toBeUndefined();
  });

  it("reads a red merge only when its own checks ended red and its parent's green", () => {
    const red = (checks: string | undefined, parentChecks: string | undefined) =>
      mergeRegression(merge, [
        {
          oid: MERGE,
          message: "fix parser (#7)",
          ...(checks ? { checks } : {}),
          ...(parentChecks ? { parentChecks } : {}),
        },
      ]);
    expect(red("FAILURE", "SUCCESS")).toEqual({ kind: "red_main", commit: MERGE });
    expect(red("ERROR", "SUCCESS")).toEqual({ kind: "red_main", commit: MERGE });
    expect(red("PENDING", "SUCCESS")).toBeUndefined();
    expect(red("FAILURE", undefined)).toBeUndefined();
    expect(red("SUCCESS", "SUCCESS")).toBeUndefined();
  });
});
