import { describe, expect, it, vi } from "vitest";
import { registerWorkboardGatewayMethods } from "./gateway.js";
import { createGatewayMethodCapture } from "./test/gateway-method-capture.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

describe("workboard gateway method registry", () => {
  it("registers CRUD methods with read/write scopes", async () => {
    const { api, methods, invoke } = createGatewayMethodCapture();

    const store = createWorkboardSqliteTestStore();
    registerWorkboardGatewayMethods({ api, store });

    expect([...methods.keys()]).toEqual([
      "workboard.cards.list",
      "workboard.cards.list.owner",
      "workboard.cards.create",
      "workboard.cards.create.owner",
      "workboard.cards.captureSession",
      "workboard.cards.update",
      "workboard.cards.start",
      "workboard.cards.stop",
      "workboard.cards.sampleRead",
      "workboard.cards.grill.end",
      "workboard.cards.move",
      "workboard.cards.move.owner",
      "workboard.cards.delete",
      "workboard.cards.comment",
      "workboard.cards.link",
      "workboard.cards.linkDependency",
      "workboard.cards.proof",
      "workboard.cards.artifact",
      "workboard.cards.claim",
      "workboard.cards.heartbeat",
      "workboard.cards.release",
      "workboard.cards.promote",
      "workboard.cards.reassign",
      "workboard.cards.reclaim",
      "workboard.cards.complete",
      "workboard.cards.block",
      "workboard.cards.unblock",
      "workboard.cards.bulk",
      "workboard.cards.diagnostics",
      "workboard.cards.diagnostics.refresh",
      "workboard.cards.dispatch",
      "workboard.cards.dispatch.owner",
      "workboard.cards.dispatchWithOptions",
      "workboard.cards.dispatchWithOptions.owner",
      "workboard.boards.list",
      "workboard.boards.upsert",
      "workboard.sessionsBoard.read",
      "workboard.sessionsBoard.update",
      "workboard.sessionsBoard.move",
      "workboard.boards.archive",
      "workboard.boards.delete",
      "workboard.cards.stats",
      "workboard.cards.trust",
      "workboard.overview",
      "workboard.transcriptViewer",
      "workboard.cards.runs",
      "workboard.cards.specify",
      "workboard.cards.decompose",
      "workboard.notifications.subscribe",
      "workboard.notifications.list",
      "workboard.notifications.delete",
      "workboard.notifications.events",
      "workboard.notifications.advance",
      "workboard.cards.attachments.list",
      "workboard.cards.attachments.get",
      "workboard.cards.screenshots.list",
      "workboard.cards.changes.diff",
      "workboard.cards.screenshots.get",
      "workboard.cards.prototypes.list",
      "workboard.cards.prototypes.get",
      "workboard.cards.attachments.add",
      "workboard.cards.attachments.delete",
      "workboard.cards.workerLog",
      "workboard.cards.protocolViolation",
      "workboard.cards.archive",
      "workboard.cards.export",
    ]);
    for (const [scope, names] of [
      [
        "operator.read",
        [
          "cards.list",
          "cards.diagnostics",
          "cards.export",
          "cards.runs",
          "overview",
          "transcriptViewer",
          "cards.attachments.get",
          "cards.screenshots.list",
          "cards.changes.diff",
          "cards.screenshots.get",
          "cards.prototypes.list",
          "cards.prototypes.get",
          "notifications.list",
          "notifications.events",
        ],
      ],
      [
        "operator.write",
        [
          "cards.diagnostics.refresh",
          "cards.create",
          "cards.stop",
          "cards.sampleRead",
          "cards.grill.end",
          "cards.attachments.add",
          "boards.upsert",
          "notifications.advance",
        ],
      ],
    ] as const) {
      for (const name of names) {
        expect(methods.get(`workboard.${name}`)?.opts).toEqual({ scope });
      }
    }

    const boardRespond = await invoke("workboard.boards.upsert", {
      id: "planning",
      automationJobId: "job-categorize-planning",
    });
    expect(boardRespond.mock.calls[0]?.[0]).toBe(true);
    await expect(store.listBoards()).resolves.toMatchObject({
      boards: [
        expect.objectContaining({ id: "default" }),
        expect.objectContaining({
          id: "planning",
          automationJobId: "job-categorize-planning",
        }),
      ],
    });

    const createHandler = methods.get("workboard.cards.create")?.handler;
    const listHandler = methods.get("workboard.cards.list")?.handler;
    const createRespond = vi.fn();
    await createHandler?.({
      params: { title: "Investigate queue drift", priority: "urgent" },
      respond: createRespond,
    } as never);
    expect(createRespond.mock.calls[0]?.[0]).toBe(true);
    expect(createRespond.mock.calls[0]?.[1]?.card).toMatchObject({
      metadata: { automation: { workspaceAccess: { unrestricted: true } } },
    });
    const createdCard = createRespond.mock.calls[0]?.[1]?.card;
    await store.move(createdCard.id, "blocked", 2000);
    const conflictRespond = await invoke("workboard.cards.update", {
      id: createdCard.id,
      expectedUpdatedAt: createdCard.updatedAt,
      patch: { title: "Stale edit" },
    });
    expect(conflictRespond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "workboard_conflict",
        details: {
          type: "workboard_card_conflict",
          card: expect.objectContaining({ status: "blocked", position: 2000 }),
        },
      }),
    );

    const listRespond = vi.fn();
    await listHandler?.({ params: {}, respond: listRespond } as never);
    expect(listRespond.mock.calls[0]?.[1]).toMatchObject({
      cards: [expect.objectContaining({ title: "Investigate queue drift" })],
      boards: expect.arrayContaining([
        expect.objectContaining({ id: "default", total: 1, active: 1 }),
      ]),
    });

    const eventsRespond = await invoke("workboard.notifications.events", { advance: true });
    expect(eventsRespond.mock.calls[0]?.[0]).toBe(false);
    expect(eventsRespond.mock.calls[0]?.[2]?.message).toContain("workboard.notifications.advance");
  });

  it.each([
    [undefined, null],
    [{ transcriptViewer: { port: 17317 } }, 17317],
  ])("serves the configured transcript viewer port (%j)", async (config, served) => {
    const { api, invoke } = createGatewayMethodCapture(config);
    registerWorkboardGatewayMethods({ api, store: createWorkboardSqliteTestStore() });

    const respond = await invoke("workboard.transcriptViewer", {});
    expect(respond.mock.calls[0]).toEqual([true, { port: served }]);
  });
});
