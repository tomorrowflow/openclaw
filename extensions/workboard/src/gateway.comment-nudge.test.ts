import { describe, expect, it, vi } from "vitest";
import { createWorkboardAutomationNudgeService } from "./automation-nudge.js";
import { registerWorkboardGatewayMethods } from "./gateway.js";
import { nudgeContext } from "./lifecycle-sync.test-support.js";
import { createGatewayMethodCapture } from "./test/gateway-method-capture.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

describe("workboard.cards.comment automation nudge", () => {
  it("nudges the board job once for an operator comment and never for a cron run's", async () => {
    const store = createWorkboardSqliteTestStore();
    await store.upsertBoard({ id: "factory", automationJobId: "job-chef" });
    await store.upsertBoard({ id: "planning", automationJobId: "job-planning" });
    const chefCard = await store.create({
      title: "Chef decision",
      status: "todo",
      boardId: "factory",
    });
    const cronCard = await store.create({
      title: "Cron note",
      status: "todo",
      boardId: "planning",
    });
    const request = vi.fn().mockResolvedValue({ ok: true, ran: true });
    const service = createWorkboardAutomationNudgeService({ store });
    await service.start(nudgeContext(request));
    const { api, invoke } = createGatewayMethodCapture();
    registerWorkboardGatewayMethods({ api, store, onOperatorComment: service.nudge });
    try {
      const respond = await invoke("workboard.cards.comment", {
        id: chefCard.id,
        body: "Go with option B.",
      });
      expect(respond).toHaveBeenCalledWith(true, {
        card: expect.objectContaining({
          metadata: expect.objectContaining({
            comments: [expect.objectContaining({ body: "Go with option B.", source: "operator" })],
          }),
        }),
      });
      expect(request.mock.calls).toEqual([["job-chef", "if-enabled"]]);

      const cronRespond = await invoke(
        "workboard.cards.comment",
        { id: cronCard.id, body: "Reviewed." },
        {
          client: {
            internal: { agentRuntimeIdentity: { sessionKey: "agent:chef:cron:job-chef:run:1" } },
          },
        },
      );
      expect(cronRespond.mock.calls[0]?.[0]).toBe(true);
      expect(request).toHaveBeenCalledOnce();
    } finally {
      service.stop();
    }
  });
});
