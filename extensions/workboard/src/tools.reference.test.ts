// Workboard tests cover an agent referencing another card with a relates_to link.
import { describe, expect, it } from "vitest";
import { relatedCardIds } from "./node-ticket-artifacts.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";
import { createWorkboardTools } from "./tools.js";

function referenceTool(store: ReturnType<typeof createWorkboardSqliteTestStore>) {
  const tool = createWorkboardTools({ store, context: { agentId: "dev" } }).find(
    (entry) => entry.name === "workboard_reference",
  );
  if (!tool) {
    throw new Error("missing tool workboard_reference");
  }
  return tool;
}

describe("workboard_reference", () => {
  it("adds one relates_to link that the card's file tabs follow", async () => {
    const store = createWorkboardSqliteTestStore();
    const prototype = await store.create({ title: "[PROTO-1] Pick a recovery flow" });
    const spec = await store.create({ title: "[SPEC-3] Specify recovery" });
    const reference = referenceTool(store);

    await reference.execute("first", { id: spec.id, targetCardId: prototype.id });
    const again = await reference.execute("again", { id: spec.id, targetCardId: prototype.id });
    expect(again.details).toMatchObject({ references: [prototype.id] });

    const linked = await store.get(spec.id);
    expect(linked?.metadata?.links).toEqual([
      expect.objectContaining({
        type: "relates_to",
        targetCardId: prototype.id,
        title: "[PROTO-1] Pick a recovery flow",
      }),
    ]);
    expect(relatedCardIds(linked!)).toEqual([prototype.id]);
    expect(linked?.status).toBe(spec.status);
  });

  it("refuses a card another agent holds the claim on, unless given its token", async () => {
    const store = createWorkboardSqliteTestStore();
    const prototype = await store.create({ title: "[PROTO-1] Pick a recovery flow" });
    const spec = await store.create({ title: "[SPEC-3] Specify recovery" });
    await store.claim(spec.id, { ownerId: "node-worker", token: "worker-token" });

    await expect(
      referenceTool(store).execute("other", { id: spec.id, targetCardId: prototype.id }),
    ).rejects.toThrow("card is claimed by node-worker.");
    expect((await store.get(spec.id))?.metadata?.links).toBeUndefined();

    await referenceTool(store).execute("owner", {
      id: spec.id,
      targetCardId: prototype.id,
      token: "worker-token",
    });
    expect(relatedCardIds((await store.get(spec.id))!)).toEqual([prototype.id]);
  });

  it("refuses a card referencing itself", async () => {
    const store = createWorkboardSqliteTestStore();
    const spec = await store.create({ title: "[SPEC-3] Specify recovery" });

    await expect(
      referenceTool(store).execute("self", { id: spec.id, targetCardId: spec.id }),
    ).rejects.toThrow("a card cannot reference itself.");
  });

  it("refuses a target card that does not exist", async () => {
    const store = createWorkboardSqliteTestStore();
    const spec = await store.create({ title: "[SPEC-3] Specify recovery" });

    await expect(
      referenceTool(store).execute("missing", { id: spec.id, targetCardId: "no-such-card" }),
    ).rejects.toThrow("card not found: no-such-card");
    expect((await store.get(spec.id))?.metadata?.links).toBeUndefined();
  });
});
