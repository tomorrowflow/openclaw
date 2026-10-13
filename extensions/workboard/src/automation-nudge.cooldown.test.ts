// Workboard tests cover the automation nudge's cooldown and busy-job retry.
import { describe, expect, it, vi } from "vitest";
import { createWorkboardAutomationNudgeService } from "./automation-nudge.js";
import {
  advanceNudgeCooldown,
  createLinkedCard,
  nudgeContext,
} from "./lifecycle-sync.test-support.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

describe("Workboard automation nudge cooldown", () => {
  it("runs a nudge that arrived during the cooldown once the cooldown ends", async () => {
    vi.useFakeTimers();
    const store = createWorkboardSqliteTestStore();
    await store.upsertBoard({ id: "planning", automationJobId: "job-categorize-planning" });
    const card = await createLinkedCard(store, { boardId: "planning" });
    const request = vi.fn().mockResolvedValue({ ok: true, ran: true });
    const service = createWorkboardAutomationNudgeService({ store });
    await service.start(nudgeContext(request));
    try {
      await service.nudge({ cards: [card] });
      // A node ticket's import reaches review moments after its agent_end nudge.
      await service.nudge({ cards: [card] });
      await service.nudge({ cards: [card] });
      expect(request).toHaveBeenCalledOnce();

      await advanceNudgeCooldown(store);
      expect(request).toHaveBeenCalledTimes(2);
      await advanceNudgeCooldown(store);
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      service.stop();
      vi.useRealTimers();
    }
  });

  it("retries a nudge the busy job skipped, with the board's current job", async () => {
    vi.useFakeTimers();
    const store = createWorkboardSqliteTestStore();
    await store.upsertBoard({ id: "planning", automationJobId: "job-old" });
    const card = await createLinkedCard(store, { boardId: "planning" });
    const request = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, ran: false, reason: "already-running" })
      .mockResolvedValue({ ok: true, ran: true });
    const service = createWorkboardAutomationNudgeService({ store });
    await service.start(nudgeContext(request));
    try {
      await service.nudge({ cards: [card] });
      await store.upsertBoard({ id: "planning", automationJobId: "job-new" });

      await advanceNudgeCooldown(store);
      expect(request.mock.calls).toEqual([
        ["job-old", "if-enabled"],
        ["job-new", "if-enabled"],
      ]);
      await advanceNudgeCooldown(store);
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      service.stop();
      vi.useRealTimers();
    }
  });
});
