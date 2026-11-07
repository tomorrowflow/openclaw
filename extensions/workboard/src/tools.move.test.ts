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
      "workboard_move needs at least one of status, priority, addLabels, or removeLabels.",
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

  it("adds and removes labels through workboard_move, keeping class labels operator-only", async () => {
    const store = createWorkboardSqliteTestStore();
    const tools = new Map(
      createWorkboardTools({ store, context: { agentId: "agent-b" } }).map((tool) => [
        tool.name,
        tool,
      ]),
    );
    const move = expectDefined(tools.get("workboard_move"), "workboard_move tool");
    const card = await store.create({
      title: "Label tool card",
      status: "todo",
      labels: ["class:docs", "needs-decision"],
    });

    const added = readPayload(
      await move.execute("move-add-labels", {
        id: card.id,
        addLabels: ["chef", "needs-decision", "chef"],
      }),
    );
    expect(added.card).toMatchObject({
      status: "todo",
      labels: ["class:docs", "needs-decision", "chef"],
    });

    const swapped = readPayload(
      await move.execute("move-swap-labels", {
        id: card.id,
        status: "ready",
        removeLabels: ["needs-decision", "absent"],
        addLabels: ["decided"],
      }),
    );
    expect(swapped.card).toMatchObject({
      status: "ready",
      labels: ["class:docs", "chef", "decided"],
    });

    await expect(
      move.execute("move-add-class", { id: card.id, addLabels: ["class:spec"] }),
    ).rejects.toThrow("class labels are operator-only");
    await expect(
      move.execute("move-remove-class", { id: card.id, removeLabels: ["class:docs"] }),
    ).rejects.toThrow("class labels are operator-only");
    expect(await store.get(card.id)).toMatchObject({ labels: ["class:docs", "chef", "decided"] });

    await store.claim(card.id, { ownerId: "agent-a", token: "test-auth-token" });
    await expect(
      move.execute("move-labels-denied", { id: card.id, addLabels: ["stolen"] }),
    ).rejects.toThrow("card is claimed by agent-a");
    expect(await store.get(card.id)).toMatchObject({ labels: ["class:docs", "chef", "decided"] });

    const claimed = readPayload(
      await move.execute("move-labels-claimed", {
        id: card.id,
        removeLabels: ["chef"],
        token: "test-auth-token",
      }),
    );
    expect(claimed.card).toMatchObject({ labels: ["class:docs", "decided"] });
  });
});
