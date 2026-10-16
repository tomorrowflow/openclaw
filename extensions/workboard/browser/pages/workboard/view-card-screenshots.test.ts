import "../../test/dom.setup.ts";
import { render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import { getWorkboardState } from "../../lib/workboard/index.ts";
import { createWorkboardCard } from "../../lib/workboard/test/index-helpers.ts";
import { workboardTestHost } from "../../test/host.setup.ts";
import { waitForFast } from "../../test/wait-for.ts";
import { renderWorkboard } from "./view.ts";

afterEach(() => vi.unstubAllGlobals());

function changes(to: string) {
  return { from: "a".repeat(40), to, files: [], totals: { files: 1, added: 0, deleted: 0 } };
}

it("shows a Screenshots tab with each round's images, pairing light and dark captures", async () => {
  let blobs = 0;
  vi.stubGlobal(
    "URL",
    class extends URL {
      static override createObjectURL = () => `blob:shot-${++blobs}`;
    },
  );
  const paths = [
    "docs/screenshots/T-1/card-dark.png",
    "docs/screenshots/T-1/card-light.png",
    "docs/screenshots/T-1/spinner.png",
  ];
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === "workboard.cards.screenshots.list") {
      return { rounds: [{ round: 0, commit: "b".repeat(40), paths }] };
    }
    if (method === "workboard.cards.screenshots.get") {
      return { mimeType: "image/png", contentBase64: btoa(String(params.path)) };
    }
    throw new Error(`unexpected ${method}`);
  });
  const host = {};
  const state = getWorkboardState(host);
  state.loaded = true;
  const card = createWorkboardCard({
    status: "review",
    rounds: [{ round: 0, changes: changes("b".repeat(40)) }],
  });
  state.cards = [card];
  state.detailCardId = card.id;
  const container = document.createElement("div");
  document.body.append(container);
  workboardTestHost().connection.connected = true;
  const renderView = () =>
    render(
      renderWorkboard({
        host,
        client: { request } as never,
        connected: true,
        agentsList: null,
        sessions: [],
        onOpenSession: () => undefined,
        onRefresh: () => undefined,
      }),
      container,
    );

  renderView();
  expect(container.querySelector("#workboard-detail-tab-screenshots")).toBeNull();
  await waitForFast(() => {
    renderView();
    expect(container.querySelector("#workboard-detail-tab-screenshots")).not.toBeNull();
  });
  expect(request).not.toHaveBeenCalledWith("workboard.cards.screenshots.get", expect.anything());

  state.detailTab = "screenshots";
  await waitForFast(() => {
    renderView();
    expect(container.querySelectorAll(".workboard-screenshot img")).toHaveLength(3);
  });
  const figures = [...container.querySelectorAll(".workboard-screenshot")];
  expect(figures.map((figure) => figure.querySelector("figcaption")?.textContent)).toEqual([
    "card.png",
    "spinner.png",
  ]);
  expect(
    [...figures[0]!.querySelectorAll(".workboard-screenshot__label")].map(
      (label) => label.textContent,
    ),
  ).toEqual(["Light", "Dark"]);
  expect(figures[0]!.querySelector("img")?.getAttribute("alt")).toBe("card-light.png");
  expect(request).toHaveBeenCalledWith("workboard.cards.screenshots.get", {
    id: card.id,
    round: 0,
    path: "docs/screenshots/T-1/spinner.png",
  });
});

it("keeps the tab hidden when no round committed an image", async () => {
  const request = vi.fn(async () => ({ rounds: [] }));
  const host = {};
  const state = getWorkboardState(host);
  state.loaded = true;
  const card = createWorkboardCard({
    id: "card-2",
    rounds: [{ round: 0, changes: changes("c".repeat(40)) }],
  });
  state.cards = [card];
  state.detailCardId = card.id;
  const container = document.createElement("div");
  document.body.append(container);
  const view = () =>
    renderWorkboard({
      host,
      client: { request } as never,
      connected: true,
      agentsList: null,
      sessions: [],
      onOpenSession: () => undefined,
      onRefresh: () => undefined,
    });
  render(view(), container);
  await waitForFast(() => expect(request).toHaveBeenCalledTimes(1));
  await Promise.resolve();
  render(view(), container);
  expect(container.querySelector("#workboard-detail-tab-screenshots")).toBeNull();
});
