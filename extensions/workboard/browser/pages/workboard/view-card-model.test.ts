import "../../test/dom.setup.ts";
import { describe, expect, it } from "vitest";
import type { WorkboardCard } from "../../lib/workboard/index.ts";
import {
  createWorkboardCard,
  createWorkboardTestClient,
} from "../../lib/workboard/test/index-helpers.ts";
import { waitForFast } from "../../test/wait-for.ts";
import { createWorkboardView } from "./view.test-support.ts";

const SONNET = "anthropic/claude-sonnet-5-5";
const FABLE = "anthropic/claude-fable-5-1";

function nodeCard(overrides: Partial<WorkboardCard> = {}): WorkboardCard {
  return createWorkboardCard({
    agentId: "dev",
    status: "blocked",
    metadata: {
      automation: {
        target: {
          kind: "node-claude",
          nodeId: "linux-node",
          repoPath: "/repo",
          worktreesRoot: "/wt",
          hostRepoPath: "/host",
          model: SONNET,
        },
      },
    },
    ...overrides,
  });
}

function modelSelect(container: Element) {
  return container.querySelector<HTMLSelectElement>("select[data-card-model]");
}

describe("card model control", () => {
  it("lists the agent's models for the card's provider and saves the choice", async () => {
    const card = nodeCard();
    const client = createWorkboardTestClient((method, params) =>
      method === "models.list"
        ? {
            models: [
              { id: "claude-fable-5-1", name: "Fable", provider: "anthropic" },
              { id: "claude-sonnet-5-5", name: "Sonnet", provider: "anthropic" },
            ],
          }
        : method === "workboard.cards.setModel"
          ? {
              card: {
                ...card,
                updatedAt: 2,
                metadata: {
                  automation: {
                    target: {
                      ...card.metadata!.automation!.target!,
                      model: (params as { model: string }).model,
                    },
                  },
                },
              },
            }
          : undefined,
    );
    const { state, container, renderView } = createWorkboardView({
      client,
      onRequestUpdate: () => renderView(),
    });
    state.cards = [card];
    state.detailCardId = card.id;
    renderView();

    const select = modelSelect(container)!;
    expect(select.value).toBe(SONNET);
    expect(select.disabled).toBe(false);
    expect(client.request).not.toHaveBeenCalledWith("models.list", expect.anything());

    select.dispatchEvent(new FocusEvent("focus"));
    await waitForFast(() =>
      expect([...modelSelect(container)!.options].map((option) => option.value)).toEqual([
        FABLE,
        SONNET,
      ]),
    );
    expect(client.request).toHaveBeenCalledWith("models.list", {
      agentId: "dev",
      provider: "anthropic",
      preparedOnly: true,
    });

    const loaded = modelSelect(container)!;
    loaded.value = FABLE;
    loaded.dispatchEvent(new Event("change", { bubbles: true }));
    await waitForFast(() => expect(state.busyCardIds.size).toBe(0));
    expect(client.request).toHaveBeenCalledWith("workboard.cards.setModel", {
      id: card.id,
      model: FABLE,
    });
    await waitForFast(() =>
      expect(state.cards[0]?.metadata?.automation?.target?.model).toBe(FABLE),
    );
  });

  it("is disabled with the reason while the card runs", () => {
    const { state, container, renderView } = createWorkboardView({
      client: createWorkboardTestClient({}),
    });
    const card = nodeCard({ status: "running" });
    state.cards = [card];
    state.detailCardId = card.id;
    renderView();

    expect(modelSelect(container)?.disabled).toBe(true);
    expect(container.querySelector(".workboard-detail__model-hint")?.textContent).toBe(
      "Stop the card to change its model.",
    );
  });

  it("is absent on a card that is not a node ticket", () => {
    const { state, container, renderView } = createWorkboardView({
      client: createWorkboardTestClient({}),
    });
    const card = createWorkboardCard();
    state.cards = [card];
    state.detailCardId = card.id;
    renderView();

    expect(modelSelect(container)).toBeNull();
  });
});
