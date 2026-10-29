// Workboard tests cover the operator's visual check of a node ticket round and the blind verifier read it reveals.
import { expectDefined } from "@openclaw/normalization-core";
import type {
  WorkboardCard,
  WorkboardNodeVisualRead,
  WorkboardOperatorCard,
} from "@openclaw/workboard-contract";
import { afterEach, describe, expect, it } from "vitest";
import { registerWorkboardGatewayMethods } from "./gateway.js";
import { isVerificationComment } from "./node-ticket.js";
import {
  finishNodeTicket,
  git,
  moveDoneAfterReviewDeadline,
  removeTempRoots,
} from "./node-ticket.test-support.js";
import { createGatewayMethodCapture } from "./test/gateway-method-capture.js";
import { createWorkboardTools } from "./tools.js";

afterEach(() => {
  removeTempRoots();
});

const VISUAL: WorkboardNodeVisualRead = {
  verdict: "looks_right",
  screenshots: [
    {
      path: "docs/screenshots/A49/today-dark.png",
      shows: "Today tab selected; Record button filled blue on black",
      verdict: "looks_right",
    },
  ],
};

function worktreeOf(card: WorkboardCard | undefined) {
  return expectDefined(card?.metadata?.automation?.target?.worktree, "node worktree");
}

/** A node ticket imported for review; `verify` records a finished verification of its round. */
async function importedTicket() {
  const ticket = await finishNodeTicket({});
  await ticket.handoffs.resume(ticket.warn);
  const { store, card } = ticket;
  const imported = worktreeOf(await store.get(card.id));
  if (imported.handoff?.phase !== "imported") {
    throw new Error(`expected an imported round, got ${imported.handoff?.phase}`);
  }
  const headCommit = imported.handoff.headCommit;
  const verify = async (overrides: { phase?: "running"; headCommit?: string } = {}) => {
    const facts = { round: 0, headCommit: overrides.headCommit ?? headCommit, startedAt: 1 };
    await store.setNodeVerification(card.id, {
      worktreePath: imported.path,
      verification:
        overrides.phase === "running"
          ? { phase: "running", ...facts, sessionKey: "agent:verifier:v", path: "/wt/verify" }
          : {
              phase: "done",
              ...facts,
              endedAt: 2,
              sessionKey: "agent:verifier:v",
              model: "openai/gpt-6-sol",
              verdict: "pass",
              summary: "xcodebuild test passed",
              findings: [],
              visual: VISUAL,
            },
    });
  };
  return { ...ticket, verify };
}

async function agentRead(ticket: Awaited<ReturnType<typeof importedTicket>>) {
  const read = expectDefined(
    createWorkboardTools({ store: ticket.store }).find((tool) => tool.name === "workboard_read"),
    "workboard_read",
  );
  const result = (await read.execute("read", { id: ticket.card.id })) as {
    details: { card: WorkboardCard };
  };
  return worktreeOf(result.details.card).verification;
}

describe("node ticket visual check", () => {
  it("records the operator's check only on the imported round's finished verification", async () => {
    const ticket = await importedTicket();
    const { store, card } = ticket;
    const check = { verdict: "problem" as const, note: "Record button grey in dark mode" };
    const unfinished = "this round's verification has not finished";

    await expect(store.setNodeVisualCheck(card.id, check)).rejects.toThrow(unfinished);
    await ticket.verify({ phase: "running" });
    await expect(store.setNodeVisualCheck(card.id, check)).rejects.toThrow(unfinished);
    await ticket.verify({ headCommit: "c".repeat(40) });
    await expect(store.setNodeVisualCheck(card.id, check)).rejects.toThrow(unfinished);

    await ticket.verify();
    await store.setNodeVisualCheck(card.id, check);
    await store.setNodeVisualCheck(card.id, { verdict: "looks_right", note: "x".repeat(600) });
    expect(worktreeOf(await store.get(card.id)).verification).toMatchObject({
      visual: VISUAL,
      visualCheck: { verdict: "looks_right", note: `${"x".repeat(399)}…`, at: expect.any(Number) },
    });

    await store.archive(card.id, true);
    await expect(store.setNodeVisualCheck(card.id, check)).rejects.toThrow(
      "only a node ticket waiting on an imported round can get a visual check.",
    );
    const plain = await store.create({ title: "Write the release notes" });
    await expect(store.setNodeVisualCheck(plain.id, check)).rejects.toThrow(
      "only a node ticket waiting on an imported round can get a visual check.",
    );
  });

  it("reveals the verifier's read to agents and the operator with one operator comment", async () => {
    const ticket = await importedTicket();
    const { store, card } = ticket;
    await ticket.verify();
    const { api, invoke } = createGatewayMethodCapture();
    registerWorkboardGatewayMethods({ api, store });
    await expect(agentRead(ticket)).resolves.not.toHaveProperty("visual");
    const commentsBefore = (await store.get(card.id))?.metadata?.comments?.length ?? 0;

    const refused = await invoke("workboard.cards.visualCheck", { id: card.id, verdict: "fine" });
    expect(refused.mock.calls[0]?.[0]).toBe(false);

    const respond = await invoke("workboard.cards.visualCheck", {
      id: card.id,
      verdict: "problem",
      note: "Record button grey in dark mode",
    });
    expect(respond.mock.calls[0]?.[0]).toBe(true);
    const [[, result]] = respond.mock.calls as [[boolean, { card: WorkboardOperatorCard }]];
    const operatorCard = result.card;
    const check = {
      verdict: "problem",
      note: "Record button grey in dark mode",
      at: expect.any(Number),
    };
    expect(operatorCard.visualCheck).toEqual({ round: 0, check });

    const comments = (await store.get(card.id))?.metadata?.comments ?? [];
    expect(comments).toHaveLength(commentsBefore + 1);
    const comment = expectDefined(comments.at(-1), "visual check comment");
    expect(comment).toMatchObject({
      source: "operator",
      body: [
        "**Visual check:** operator problem · verifier looks_right",
        "",
        "Record button grey in dark mode",
        "",
        "- `docs/screenshots/A49/today-dark.png` looks_right: Today tab selected; Record button filled blue on black",
      ].join("\n"),
    });
    expect(isVerificationComment(comment)).toBe(false);
    await expect(agentRead(ticket)).resolves.toMatchObject({ visual: VISUAL, visualCheck: check });
  });

  it("copies the visual check into the round's review entry only when the operator recorded one", async () => {
    const publish = async (checked: boolean) => {
      const ticket = await importedTicket();
      const { store, card, repos, github, handoffs, warn } = ticket;
      await ticket.verify();
      if (checked) {
        await store.setNodeVisualCheck(card.id, { verdict: "problem" });
      }
      git(repos.hostRepo, "remote", "set-url", "origin", "git@github.com:acme/app.git");
      github.tokens.set("acme/app", "token-app");
      await moveDoneAfterReviewDeadline(store, card.id);
      await handoffs.resume(warn);
      return worktreeOf(await store.get(card.id)).reviews?.[0]?.verification;
    };

    await expect(publish(true)).resolves.toMatchObject({
      verdict: "pass",
      visual: { verifier: "looks_right", operator: "problem" },
    });
    const unchecked = await publish(false);
    expect(unchecked).toMatchObject({ verdict: "pass" });
    expect(unchecked).not.toHaveProperty("visual");
  });
});
