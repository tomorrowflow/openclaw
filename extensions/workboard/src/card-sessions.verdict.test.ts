// Workboard tests cover recording the session that posted a node ticket round's verdict.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { redactOperatorCard } from "./card-redaction.js";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import { syncWorkboardAgentEnded } from "./lifecycle-sync.js";
import {
  doneReport,
  endedSession,
  finishNodeTicket,
  git,
  postVerdict,
  removeTempRoots,
} from "./node-ticket.test-support.js";
import { MAX_NODE_SESSION_KEY_CHARS } from "./store-constants.js";
import type { WorkboardStore } from "./store.js";
import { createWorkboardTools } from "./tools.js";

afterEach(() => {
  removeTempRoots();
});

const handoffOf = async (store: WorkboardStore, cardId: string) =>
  (await store.get(cardId))?.metadata?.automation?.target?.worktree?.handoff;

const agentComment = async (
  store: WorkboardStore,
  cardId: string,
  body: string,
  sessionKey: string,
) => await store.addComment(cardId, { body }, undefined, "agent:dev", sessionKey);

it("records the session that posted the verdict, hidden from the operator until the decision", async () => {
  const { store, card, repos, handoffs, warn, github } = await finishNodeTicket({});
  await handoffs.resume(warn);
  git(repos.hostRepo, "remote", "set-url", "origin", "git@github.com:acme/app.git");
  github.tokens.set("acme/app", "token-app");
  const reviewSession = "agent:dev:review-verdict";
  const comment = expectDefined(
    createWorkboardTools({ store, context: { agentId: "dev", sessionKey: reviewSession } }).find(
      (tool) => tool.name === "workboard_comment",
    ),
    "workboard_comment",
  );
  await comment.execute("verdict", { id: card.id, body: "Verdict: accept" });

  const undecided = redactOperatorCard(expectDefined(await store.get(card.id), "card"));
  expect(JSON.stringify(undecided)).not.toContain(reviewSession);
  expect(undecided.sessions).toContainEqual({
    role: "verdict",
    round: 0,
    state: "finished",
    blind: true,
  });

  await store.move(card.id, "done", undefined);
  await handoffs.resume(warn);
  const published = expectDefined(await store.get(card.id), "card");
  expect(published.metadata?.automation?.target?.worktree?.reviews).toEqual([
    expect.objectContaining({ verdict: "accept", verdictSessionKey: reviewSession }),
  ]);
  expect(redactOperatorCard(published).sessions).toContainEqual({
    role: "verdict",
    round: 0,
    state: "finished",
    sessionKey: reviewSession,
  });
});

it("records the newest verdict's session and nothing for other agent comments", async () => {
  const { store, card, handoffs, warn } = await finishNodeTicket({});
  await handoffs.resume(warn);

  await agentComment(store, card.id, "Looks close.", "agent:dev:a");
  expect(await handoffOf(store, card.id)).not.toHaveProperty("verdictSessionKey");

  await agentComment(store, card.id, "Verdict: rework", "agent:dev:a");
  await agentComment(store, card.id, "Verdict: accept", "agent:dev:b");
  expect(await handoffOf(store, card.id)).toMatchObject({ verdictSessionKey: "agent:dev:b" });
});

it("posts a verdict whose session key is too long without recording it", async () => {
  const { store, card, handoffs, warn } = await finishNodeTicket({});
  await handoffs.resume(warn);

  const stored = await agentComment(
    store,
    card.id,
    "Verdict: accept",
    `agent:dev:${"x".repeat(MAX_NODE_SESSION_KEY_CHARS)}`,
  );

  expect(stored.metadata?.comments?.at(-1)?.body).toBe("Verdict: accept");
  expect(await handoffOf(store, card.id)).not.toHaveProperty("verdictSessionKey");
});

it("records no verdict session outside review", async () => {
  const { store, card, repos, handoffs, warn } = await finishNodeTicket({});
  await handoffs.resume(warn);
  await postVerdict(store, card.id);
  git(repos.hostRepo, "remote", "set-url", "origin", "git@github.com:acme/app.git");
  await store.move(card.id, "done", undefined);
  // No GitHub token, so the publish fails and the imported round waits blocked.
  await handoffs.resume(warn);
  expect((await store.get(card.id))?.status).toBe("blocked");

  await agentComment(store, card.id, "Verdict: accept", "agent:dev:late");

  expect(await handoffOf(store, card.id)).toMatchObject({ phase: "imported" });
  expect(await handoffOf(store, card.id)).not.toHaveProperty("verdictSessionKey");
});

it("starts a rework round's import without the previous round's verdict session", async () => {
  const { store, card, repos, worktree, handoffs, warn, github, gateway } = await finishNodeTicket(
    {},
  );
  await handoffs.resume(warn);
  await agentComment(store, card.id, "Verdict: accept", "agent:dev:r0");
  git(repos.hostRepo, "remote", "set-url", "origin", "git@github.com:acme/app.git");
  github.tokens.set("acme/app", "token-app");
  github.openPulls.push("https://github.com/acme/app/pull/7");
  await store.move(card.id, "done", undefined);
  await handoffs.resume(warn);
  await store.move(card.id, "todo", undefined);
  await store.addComment(card.id, { body: "Rename the flag to --strict." });
  const { started } = await dispatchAndStartWorkboardCards({
    store,
    subagent: { run: vi.fn() },
    nodeTickets: gateway,
    options: { cardId: card.id, now: Date.now() },
  });
  writeFileSync(path.join(worktree, "parser.py"), "strict\n");
  git(worktree, "commit", "-qam", "rename flag");
  const { runId, sessionKey } = started[0] ?? {};
  await syncWorkboardAgentEnded({
    store,
    event: { runId, success: true, messages: doneReport },
    context: { runId, sessionKey },
    readSessions: endedSession(),
  });
  await handoffs.resume(warn);

  const reworked = expectDefined(await store.get(card.id), "card");
  const reworkedTree = reworked.metadata?.automation?.target?.worktree;
  expect(reworked.status).toBe("review");
  expect(reworkedTree?.rework?.round).toBe(1);
  expect(reworkedTree?.handoff).toMatchObject({ phase: "imported" });
  expect(reworkedTree?.handoff).not.toHaveProperty("verdictSessionKey");
  expect(reworkedTree?.reviews?.[0]).toMatchObject({ verdictSessionKey: "agent:dev:r0" });
});
