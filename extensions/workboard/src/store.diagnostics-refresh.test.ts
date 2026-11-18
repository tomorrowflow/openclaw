import { describe, expect, it, vi } from "vitest";
import { createKernelStores } from "./test/sqlite-kernel.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

describe("WorkboardStore diagnostics refresh", () => {
  it("leaves cards untouched when a refresh re-observes the same diagnostics", async () => {
    vi.useFakeTimers();
    try {
      const hour = 60 * 60 * 1000;
      vi.setSystemTime(1000);
      const store = createWorkboardSqliteTestStore({ createStores: createKernelStores });
      const ready = await store.create({ title: "Ready too long", agentId: "main" });

      vi.setSystemTime(1000 + 2 * hour);
      await store.refreshDiagnostics();
      const flagged = await store.get(ready.id);
      expect(flagged?.metadata?.diagnostics).toEqual([
        expect.objectContaining({ kind: "stranded_ready", count: 1, lastSeenAt: 1000 + 2 * hour }),
      ]);
      expect(flagged?.events?.at(-1)).toMatchObject({ kind: "diagnostic" });

      // The flagging write bumped updatedAt; the card stays stranded and unwritten.
      vi.setSystemTime(1000 + 3 * hour);
      await store.refreshDiagnostics();
      await expect(store.get(ready.id)).resolves.toEqual(flagged);

      await store.addComment(ready.id, { body: "Picking this up." });
      vi.setSystemTime(1000 + 3 * hour + 60_000);
      await store.refreshDiagnostics();
      expect((await store.get(ready.id))?.metadata?.diagnostics ?? []).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
