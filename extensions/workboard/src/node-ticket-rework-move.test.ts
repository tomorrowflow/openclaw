// Workboard tests cover the operator deciding rework on an imported, unpublished node ticket.
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import { finishNodeTicket, git, postVerdict, removeTempRoots } from "./node-ticket.test-support.js";

afterEach(() => {
  removeTempRoots();
});

describe("node ticket rework from review", () => {
  it("publishes an imported round moved to todo, then reworks it with the earlier feedback", async () => {
    const { store, card, repos, handoffs, warn, github, gateway } = await finishNodeTicket({});
    await handoffs.resume(warn);
    await postVerdict(store, card.id, "Verdict: rework: the flag name is wrong");
    git(repos.hostRepo, "remote", "set-url", "origin", "git@github.com:acme/app.git");
    await store.addComment(card.id, { body: "Rename the flag to --strict." });

    await store.move(card.id, "todo", undefined);
    await handoffs.resume(warn);

    const blocked = await store.get(card.id);
    expect(blocked?.status).toBe("blocked");
    expect(blocked?.metadata?.comments?.at(-1)?.body).toContain(
      "Fix the cause, then move the card to todo again to retry.",
    );

    github.tokens.set("acme/app", "token-app");
    github.openPulls.push("https://github.com/acme/app/pull/7");
    await store.move(card.id, "todo", undefined);
    await handoffs.resume(warn);
    await handoffs.resume(warn);

    expect(warn).not.toHaveBeenCalled();
    const stored = await store.get(card.id);
    expect(stored?.status).toBe("running");
    expect(stored?.metadata?.automation?.target?.worktree?.rework).toMatchObject({ round: 1 });
    expect(stored?.metadata?.automation?.target?.worktree?.reviews?.at(-1)).toMatchObject({
      verdict: "rework",
    });
    const message = String(
      gateway.respond.mock.calls.findLast(([method]) => method === "sessions.create")?.[1]?.message,
    );
    expect(message).toContain("Review rework, round 1");
    expect(message).toContain("Rename the flag to --strict.");
    expect(message.split("## Turn contract")[0]).not.toContain("Draft PR failed");
  });
  it("refuses an operator's Start while a round moved to todo waits for its draft PR, then reworks it", async () => {
    const { store, card, repos, handoffs, warn, github, gateway } = await finishNodeTicket({});
    await handoffs.resume(warn);
    await postVerdict(store, card.id, "Verdict: rework: the flag name is wrong");
    git(repos.hostRepo, "remote", "set-url", "origin", "git@github.com:acme/app.git");
    github.tokens.set("acme/app", "token-app");
    github.openPulls.push("https://github.com/acme/app/pull/7");
    await store.addComment(card.id, { body: "Rename the flag to --strict." });

    const moved = await store.move(card.id, "todo", undefined);
    // The Control UI offers Start on the moved card before the handoff pass publishes.
    const { started, startFailures } = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run: vi.fn() },
      nodeTickets: gateway,
      options: { cardId: card.id, maxStarts: 1, queue: "request", now: moved.updatedAt },
    });
    expect(started).toEqual([]);
    expect(startFailures[0]?.error).toContain("starts by itself");
    expect((await store.get(card.id))?.status).toBe("todo");

    await handoffs.resume(warn);
    await handoffs.resume(warn);

    expect(warn).not.toHaveBeenCalled();
    const stored = await store.get(card.id);
    expect(stored?.status).toBe("running");
    expect(stored?.metadata?.automation?.target?.worktree?.rework).toMatchObject({ round: 1 });
  });

  it("refuses to turn an Unblock after a failed accept into rework", async () => {
    const { store, card, repos, handoffs, warn } = await finishNodeTicket({});
    await handoffs.resume(warn);
    await postVerdict(store, card.id);
    git(repos.hostRepo, "remote", "set-url", "origin", "git@github.com:acme/app.git");
    await store.move(card.id, "done", undefined);
    await handoffs.resume(warn);
    expect((await store.get(card.id))?.status).toBe("blocked");

    await expect(store.unblock(card.id)).rejects.toThrow("This round was accepted");
    expect((await store.get(card.id))?.status).toBe("blocked");
  });

  it("sends a move to todo without feedback after the verdict back to backlog", async () => {
    const { store, card, repos, handoffs, warn, github } = await finishNodeTicket({});
    await handoffs.resume(warn);
    await store.addComment(card.id, { body: "Early note before the review." });
    await postVerdict(store, card.id, "Verdict: rework: the flag name is wrong");
    git(repos.hostRepo, "remote", "set-url", "origin", "git@github.com:acme/app.git");
    github.tokens.set("acme/app", "token-app");
    github.openPulls.push("https://github.com/acme/app/pull/7");

    await store.move(card.id, "todo", undefined);
    await handoffs.resume(warn);
    await handoffs.resume(warn);

    const stored = await store.get(card.id);
    expect(stored?.status).toBe("backlog");
    expect(stored?.metadata?.comments?.at(-1)?.body).toContain("Reopened without a review comment");
  });
});
