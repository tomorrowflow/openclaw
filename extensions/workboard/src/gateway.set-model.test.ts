import { describe, expect, it, vi } from "vitest";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import { registerWorkboardGatewayMethods } from "./gateway.js";
import {
  NODE_TARGET,
  createNodeCard,
  createNodeGateway,
  startNodeCard,
} from "./node-ticket.test-support.js";
import { createGatewayMethodCapture } from "./test/gateway-method-capture.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

const FABLE = "anthropic/claude-fable-5-1";

function setup() {
  const store = createWorkboardSqliteTestStore();
  const { api, invoke } = createGatewayMethodCapture();
  registerWorkboardGatewayMethods({ api, store });
  const setModel = async (id: string, model: string) => {
    const respond = await invoke("workboard.cards.setModel", { id, model });
    const [ok, payload, error] = respond.mock.calls[0] ?? [];
    return { ok, payload, error };
  };
  return { store, setModel };
}

describe("workboard.cards.setModel", () => {
  it("changes a node ticket's model, keeps its worktree, and the next start runs it", async () => {
    const { store, setModel } = setup();
    const nodeTickets = createNodeGateway();
    const { card } = await startNodeCard(store, nodeTickets);
    const claim = (await store.get(card.id))?.metadata?.claim;
    await store.block(card.id, { reason: "session limit" }, claim);
    const before = (await store.get(card.id))?.metadata?.automation?.target;
    expect(before?.worktree?.branch).toBeTruthy();

    const result = await setModel(card.id, FABLE);

    expect(result.ok).toBe(true);
    expect((await store.get(card.id))?.metadata?.automation?.target).toEqual({
      ...before,
      model: FABLE,
    });

    nodeTickets.respond.mockClear();
    await store.move(card.id, "ready", undefined);
    const restarted = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run: vi.fn() },
      nodeTickets,
      options: { now: Date.now(), maxStarts: 1, cardId: card.id },
    });
    expect(restarted.startFailures).toEqual([]);
    const creates = nodeTickets.respond.mock.calls.filter(
      ([method]) => method === "sessions.create",
    );
    expect(creates.map(([, params]) => (params as { model?: string }).model)).toEqual([FABLE]);
  });

  it("refuses a model the card's agent may not run", async () => {
    const { store, setModel } = setup();
    store.checkTargetModel = ({ agentId, model }) =>
      agentId === "dev" && model === FABLE ? "not in modelPolicy.allow" : undefined;
    const card = await createNodeCard(store);

    const result = await setModel(card.id, FABLE);

    expect(result.ok).toBe(false);
    expect(String(result.error?.message)).toContain("not in modelPolicy.allow");
    expect((await store.get(card.id))?.metadata?.automation?.target?.model).toBe(NODE_TARGET.model);
  });

  it("refuses while the card runs", async () => {
    const { store, setModel } = setup();
    const { card } = await startNodeCard(store);

    const result = await setModel(card.id, FABLE);

    expect(result.ok).toBe(false);
    expect(String(result.error?.message)).toContain("stop the card");
    expect((await store.get(card.id))?.metadata?.automation?.target?.model).toBe(NODE_TARGET.model);
  });

  it("refuses a card that is not a node ticket", async () => {
    const { store, setModel } = setup();
    const card = await store.create({ title: "Plain card", status: "todo" });

    const result = await setModel(card.id, FABLE);

    expect(result.ok).toBe(false);
    expect(String(result.error?.message)).toContain("only node ticket cards");
  });
});
