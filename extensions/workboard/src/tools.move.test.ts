import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";
import { createWorkboardTools } from "./tools.js";
import { readPayload } from "./tools.test-support.js";

describe("workboard_move tool", () => {
  it("moves cards with agent claim scope", async () => {
    const store = createWorkboardSqliteTestStore();
    const tools = new Map(
      createWorkboardTools({ store, context: { agentId: "agent-b" } }).map((tool) => [
        tool.name,
        tool,
      ]),
    );
    const card = await store.create({ title: "Move tool card", status: "todo" });

    const unclaimed = readPayload(
      await tools.get("workboard_move")?.execute("move-unclaimed", {
        id: card.id,
        status: "ready",
      }),
    );
    expect(unclaimed.card).toMatchObject({ status: "ready" });

    await store.claim(card.id, { ownerId: "agent-a", token: "test-auth-token" });
    await expect(
      tools.get("workboard_move")?.execute("move-denied", {
        id: card.id,
        status: "review",
      }),
    ).rejects.toThrow("card is claimed by agent-a");

    const claimed = readPayload(
      await tools.get("workboard_move")?.execute("move-claimed", {
        id: card.id,
        status: "review",
        token: "test-auth-token",
      }),
    );
    // Review is not terminal: the claim stays with its owner.
    expect(claimed.card).toMatchObject({
      status: "review",
      metadata: { claim: { ownerId: "agent-a" } },
    });
  });

  it("changes card priority through workboard_move under claim scope", async () => {
    const store = createWorkboardSqliteTestStore();
    const tools = new Map(
      createWorkboardTools({ store, context: { agentId: "agent-b" } }).map((tool) => [
        tool.name,
        tool,
      ]),
    );
    const move = expectDefined(tools.get("workboard_move"), "workboard_move tool");
    const card = await store.create({ title: "Priority tool card", status: "todo" });

    await expect(move.execute("move-nothing", { id: card.id })).rejects.toThrow(
      "workboard_move needs a status, a priority, or both.",
    );

    const prioritized = readPayload(
      await move.execute("move-priority-only", { id: card.id, priority: "high" }),
    );
    expect(prioritized.card).toMatchObject({ status: "todo", priority: "high" });

    const both = readPayload(
      await move.execute("move-both", { id: card.id, status: "ready", priority: "urgent" }),
    );
    expect(both.card).toMatchObject({ status: "ready", priority: "urgent" });

    const claimed = (await store.claim(card.id, { ownerId: "agent-a", token: "test-auth-token" }))
      .card;
    await expect(
      move.execute("move-priority-denied", { id: card.id, priority: "low" }),
    ).rejects.toThrow("card is claimed by agent-a");
    expect(await store.get(card.id)).toMatchObject({
      status: claimed.status,
      priority: "urgent",
    });

    const lowered = readPayload(
      await move.execute("move-priority-claimed", {
        id: card.id,
        priority: "low",
        token: "test-auth-token",
      }),
    );
    expect(lowered.card).toMatchObject({ status: claimed.status, priority: "low" });
  });
});
