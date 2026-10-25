// Workboard tests cover holding an imported round until its verification and verdict exist.
import { expectDefined } from "@openclaw/normalization-core";
import type { WorkboardNodeVerification } from "@openclaw/workboard-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nodeTicketTarget } from "./node-ticket.js";
import { postVerdict, startNodeCard } from "./node-ticket.test-support.js";
import { REVIEW_READINESS_DEADLINE_MS } from "./review-readiness.js";
import type { WorkboardStore } from "./store.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";
import { createWorkboardTools } from "./tools.js";

const HEAD = "b".repeat(40);

afterEach(() => {
  vi.useRealTimers();
});

/** A docs ticket at rung b imported as the bundle import leaves it, waiting in review. */
async function importedTicket(params: { verify?: boolean } = {}) {
  const store = createWorkboardSqliteTestStore();
  await store.upsertBoard({
    id: "default",
    orchestration: { classRungs: { docs: { rung: "b", sampleEvery: 1 } } },
  });
  const { card } = await startNodeCard(store, undefined, undefined, ["class:docs"]);
  const running = expectDefined(await store.get(card.id), "running card");
  const claim = expectDefined(running.metadata?.claim, "claim");
  const worktree = expectDefined(nodeTicketTarget(running)?.worktree, "worktree");
  await store.setNodeHandoff(
    card.id,
    {
      worktreePath: worktree.path,
      handoff: {
        phase: "imported",
        headCommit: HEAD,
        importedAt: Date.now(),
        ...(params.verify ? { verify: true as const } : {}),
      },
    },
    claim,
  );
  await store.releaseClaim(card.id, {
    ownerId: claim.ownerId,
    token: claim.token,
    status: "review",
  });
  const settleVerification = async (verdict: "pass" | "fail" = "pass") => {
    const verification: WorkboardNodeVerification = {
      phase: "done",
      round: 0,
      headCommit: HEAD,
      startedAt: Date.now(),
      endedAt: Date.now(),
      verdict,
      summary: "checked",
      findings: [],
    };
    await store.setNodeVerification(card.id, { worktreePath: worktree.path, verification });
  };
  return { store, card, settleVerification };
}

function agentMove(store: WorkboardStore, id: string) {
  const move = createWorkboardTools({ store, context: { agentId: "dev" } }).find(
    (tool) => tool.name === "workboard_move",
  );
  return async () =>
    await expectDefined(move, "workboard_move").execute("move", { id, status: "done" });
}

const VERIFYING = "verification is still running";
const NO_VERDICT = "hasn't posted its verdict";

describe("imported round readiness", () => {
  it("refuses the operator's decision until the verification and the verdict exist", async () => {
    const { store, card, settleVerification } = await importedTicket({ verify: true });

    await expect(store.move(card.id, "done", undefined)).rejects.toThrow(VERIFYING);
    await settleVerification();
    await expect(store.move(card.id, "done", undefined)).rejects.toThrow(NO_VERDICT);
    expect((await store.get(card.id))?.status).toBe("review");

    await postVerdict(store, card.id);
    await expect(store.move(card.id, "done", undefined)).resolves.toMatchObject({ status: "done" });
  });

  it("waits only for the verdict when the board had no verifier at import", async () => {
    const { store, card } = await importedTicket();

    await expect(store.move(card.id, "done", undefined)).rejects.toThrow(NO_VERDICT);
    await postVerdict(store, card.id);
    await expect(store.move(card.id, "done", undefined)).resolves.toMatchObject({ status: "done" });
  });

  it("leaves an agent's move to its acceptance checks, which ask it for its verdict", async () => {
    const { store, card } = await importedTicket({ verify: true });
    const move = agentMove(store, card.id);

    await expect(move()).rejects.toThrow("as a comment first");
    await postVerdict(store, card.id);
    await move();
    expect((await store.get(card.id))?.status).toBe("done");
  });

  it("lets the operator decide a round that never got them once the deadline passed", async () => {
    const { store, card } = await importedTicket({ verify: true });

    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + REVIEW_READINESS_DEADLINE_MS });
    await expect(store.move(card.id, "done", undefined)).resolves.toMatchObject({ status: "done" });
  });
});
