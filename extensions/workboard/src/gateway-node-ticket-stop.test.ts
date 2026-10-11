import type { WorkboardCard } from "@openclaw/workboard-contract";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import { registerWorkboardGatewayMethods } from "./gateway.js";
import { startNodeCard } from "./node-ticket.test-support.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

function createGatewayMethodCapture() {
  const methods = new Map<string, Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1]>();
  const api = {
    runtime: {},
    registerGatewayMethod: vi.fn(
      (method: string, handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1]) => {
        methods.set(method, handler);
      },
    ),
  } as unknown as OpenClawPluginApi;
  const invoke = async (name: string, params: Record<string, unknown>) => {
    const respond = vi.fn();
    await methods.get(name)!({ params, respond } as never);
    return respond;
  };
  return { api, invoke };
}

describe("workboard.cards.stop", () => {
  async function setup(abortReply: (card: WorkboardCard | undefined) => unknown) {
    const { api, invoke } = createGatewayMethodCapture();
    const store = createWorkboardSqliteTestStore();
    const { card, sessionKey, runId } = await startNodeCard(store);
    const request = vi.fn(async (method: string) => {
      expect(method).toBe("chat.abort");
      return abortReply(await store.get(card.id));
    });
    (api.runtime as { gateway: unknown }).gateway = { request };
    registerWorkboardGatewayMethods({ api, store });
    const running = await store.get(card.id);
    return { store, invoke, request, card, sessionKey, runId, updatedAt: running!.updatedAt };
  }

  it("records the stop before aborting and puts the node ticket back in todo", async () => {
    const { store, invoke, request, card, sessionKey, runId, updatedAt } = await setup(
      (current) => {
        // The run's end must already read the operator's stop.
        expect(current?.metadata?.automation?.target?.worktree?.stopRequestedAt).toBeTypeOf(
          "number",
        );
        return { ok: true, aborted: true, runIds: [runId] };
      },
    );

    const respond = await invoke("workboard.cards.stop", {
      id: card.id,
      expectedUpdatedAt: updatedAt,
    });

    expect(request).toHaveBeenCalledWith(
      "chat.abort",
      { sessionKey, runId },
      { scopes: ["operator.write"] },
    );
    expect(respond.mock.calls[0]?.[0]).toBe(true);
    const stored = await store.get(card.id);
    expect(stored?.status).toBe("todo");
    expect(stored?.metadata?.claim).toBeUndefined();
    expect(stored?.metadata?.failureCount ?? 0).toBe(0);
    expect(stored?.metadata?.attempts?.at(-1)?.status).toBe("stopped");
  });

  it("drops the stop request when the session had no active run", async () => {
    const { store, invoke, request, card, updatedAt } = await setup(() => ({
      ok: true,
      aborted: false,
      runIds: [],
    }));

    const respond = await invoke("workboard.cards.stop", {
      id: card.id,
      expectedUpdatedAt: updatedAt,
    });

    // The targeted abort found nothing, so the session-wide retry ran too.
    expect(request).toHaveBeenCalledTimes(2);
    expect(respond.mock.calls[0]?.[0]).toBe(false);
    const stored = await store.get(card.id);
    expect(stored?.status).toBe("running");
    expect(stored?.metadata?.automation?.target?.worktree?.stopRequestedAt).toBeUndefined();
  });

  it("leaves a stop already in flight to its own abort", async () => {
    const { store, invoke, request, card } = await setup(() => ({ aborted: false }));
    const first = await store.nodeTicketStop(card.id, { action: "request" });

    const respond = await invoke("workboard.cards.stop", { id: card.id });

    expect(request).not.toHaveBeenCalled();
    expect(respond.mock.calls[0]?.[0]).toBe(true);
    const stored = await store.get(card.id);
    expect(stored?.status).toBe("running");
    expect(stored?.metadata?.automation?.target?.worktree?.stopRequestedAt).toBe(
      first.card.metadata?.automation?.target?.worktree?.stopRequestedAt,
    );
  });
});
