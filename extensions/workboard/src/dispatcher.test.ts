import { beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import type { WorkboardStore } from "./store.js";
import { createWorkboardSqliteTestHarness } from "./test/sqlite-store.js";

describe("dispatchAndStartWorkboardCards", () => {
  let store: WorkboardStore;
  let run = vi.fn();
  beforeEach(() => {
    store = createWorkboardSqliteTestHarness().store;
    run = vi.fn();
  });
  const dispatch = (cardId?: string) =>
    dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { maxStarts: 1, ...(cardId ? { cardId } : {}) },
    });

  it("never starts a retro card, whether started directly or dispatched", async () => {
    const retro = await store.create({ title: "Retro", status: "todo", kind: "retro" });
    const direct = await dispatch(retro.id);
    expect(direct.startFailures).toEqual([
      expect.objectContaining({ cardId: retro.id, error: expect.stringContaining("never starts") }),
    ]);
    expect(run).not.toHaveBeenCalled();

    await store.update(retro.id, { status: "ready" });
    const scheduled = await dispatch();
    expect(scheduled.started).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    await expect(store.get(retro.id)).resolves.toMatchObject({ status: "ready" });
  });
});
