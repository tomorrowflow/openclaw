import "../../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { normalizeCardsPayload } from "../../lib/workboard/normalization.ts";
import {
  createWorkboardCard,
  createWorkboardTestClient,
} from "../../lib/workboard/test/index-helpers.ts";
import { waitForFast } from "../../test/wait-for.ts";
import { createWorkboardView } from "./view.test-support.ts";

const text = (element: Element | null | undefined) =>
  element?.textContent?.replace(/\s+/g, " ").trim();

const HEAD = "4f2a9c1e".padEnd(40, "0");
const PREVIEW = {
  headCommit: HEAD,
  nodeId: "linux-factory",
  path: "/home/factory/worktrees/wb-card-1-preview",
  down: ["python3", "scripts/env.py", "down"],
  port: 48600,
  at: 1,
};
const URL = "https://linux-factory.tail1234.ts.net:48600";

function previewCard(preview: Record<string, unknown> | undefined) {
  const [card] = normalizeCardsPayload({
    cards: [{ ...createWorkboardCard({ status: "review" }), ...(preview ? { preview } : {}) }],
  }).cards;
  return expectDefined(card, "card");
}

function renderDrawer(card: ReturnType<typeof previewCard>, client: GatewayBrowserClient) {
  const view = createWorkboardView({ client, connected: true, canWrite: true });
  view.state.cards = [card];
  view.state.detailCardId = card.id;
  view.state.detailTab = "preview";
  view.renderView();
  return view.container;
}

function panelOf(container: HTMLElement) {
  return expectDefined(container.querySelector("#workboard-detail-panel-preview"), "preview panel");
}

it("links a running preview in a new tab and names its node and head", () => {
  const container = renderDrawer(
    previewCard({ ...PREVIEW, state: "up", url: URL }),
    createWorkboardTestClient({}),
  );

  expect(text(container.querySelector("#workboard-detail-tab-preview"))).toBe("Preview");
  const panel = panelOf(container);
  expect(text(panel.querySelector(".workboard-preview__status"))).toBe(
    "Running on linux-factory at 4f2a9c1e.",
  );
  const link = expectDefined(
    panel.querySelector<HTMLAnchorElement>("[data-preview-action=open]"),
    "preview link",
  );
  expect(link.href).toBe(`${URL}/`);
  expect(link.target).toBe("_blank");
  expect(link.rel).toBe("noopener");
  expect(panel.querySelector("[data-preview-action=retry]")).toBeNull();
});

it("says a preview is starting, without a link", () => {
  const container = renderDrawer(
    previewCard({ ...PREVIEW, state: "starting" }),
    createWorkboardTestClient({}),
  );

  const panel = panelOf(container);
  expect(text(panel.querySelector(".workboard-preview__status"))).toBe(
    "Starting the preview on linux-factory at 4f2a9c1e…",
  );
  expect(panel.querySelector("[data-preview-action]")).toBeNull();
});

it("shows a failed preview's error and retries it", async () => {
  const error =
    "The board's preview up failed on linux-factory: port is already allocated. Fix the stack or the board's preview.up, then Retry.";
  const card = previewCard({ ...PREVIEW, state: "failed", error });
  const retried = previewCard({ ...PREVIEW, state: "starting", at: 2 });
  const client = createWorkboardTestClient({
    "workboard.cards.preview.retry": { card: retried },
  });
  const container = renderDrawer(card, client);

  const panel = panelOf(container);
  expect(text(panel.querySelector(".workboard-preview__status"))).toBe(
    "The preview on linux-factory at 4f2a9c1e failed.",
  );
  expect(text(panel.querySelector(".workboard-preview__error"))).toBe(error);
  expectDefined(
    panel.querySelector<HTMLButtonElement>("[data-preview-action=retry]"),
    "retry button",
  ).click();

  await waitForFast(() =>
    expect(client.request).toHaveBeenCalledWith("workboard.cards.preview.retry", { id: card.id }),
  );
  await waitForFast(() =>
    expect(text(panelOf(container).querySelector(".workboard-preview__status"))).toBe(
      "Starting the preview on linux-factory at 4f2a9c1e…",
    ),
  );
});

it("offers no Preview tab on a card without a preview", () => {
  const container = renderDrawer(previewCard(undefined), createWorkboardTestClient({}));

  expect(container.querySelector("#workboard-detail-tab-preview")).toBeNull();
  expect(container.querySelector("#workboard-detail-panel-preview")).toBeNull();
});
