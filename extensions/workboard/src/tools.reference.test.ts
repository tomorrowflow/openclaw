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
    await reference.execute("again", { id: spec.id, targetCardId: prototype.id });

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

  it("refuses a target card that does not exist", async () => {
    const store = createWorkboardSqliteTestStore();
    const spec = await store.create({ title: "[SPEC-3] Specify recovery" });

    await expect(
      referenceTool(store).execute("missing", { id: spec.id, targetCardId: "no-such-card" }),
    ).rejects.toThrow("card not found: no-such-card");
    expect((await store.get(spec.id))?.metadata?.links).toBeUndefined();
  });
});
