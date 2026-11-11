// Workboard tests cover recording the session that posted a node ticket round's verdict.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it } from "vitest";
import { redactOperatorCard } from "./card-redaction.js";
import { finishNodeTicket, git, removeTempRoots } from "./node-ticket.test-support.js";
import { createWorkboardTools } from "./tools.js";

afterEach(() => {
  removeTempRoots();
});

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
