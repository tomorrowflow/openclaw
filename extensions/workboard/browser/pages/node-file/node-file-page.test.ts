import "../../test/dom.setup.ts";
import { afterEach, expect, it, vi } from "vitest";
import { workboardTestHost } from "../../test/host.setup.ts";
import { createViewContext } from "../../test/host.ts";
import { createPrototypePage, createScreenshotPage } from "./node-file-page.tsx";
import {
  nodeFilePageTarget,
  parseNodeFileTarget,
  PROTOTYPE_PAGE_ID,
  SCREENSHOT_PAGE_ID,
} from "./node-file-target.ts";

const GET = "workboard.cards.prototypes.get";
const PATH = "docs/prototypes/ONB-4/checklist.html";

const mounted: Array<() => void> = [];
afterEach(() => {
  for (const dispose of mounted.splice(0)) {
    dispose();
  }
  document.body.replaceChildren();
});

function mountPrototypePage(
  params: Readonly<Record<string, string>>,
  get: (params: Record<string, unknown>) => Promise<unknown> = async (input) => ({
    html: `<p>${String(input.path)}</p>`,
  }),
  connected = true,
) {
  const fixture = workboardTestHost();
  fixture.connection.connected = connected;
  const request = vi.fn(async (method: string, input?: unknown) => {
    if (method === GET) {
      return await get(input as Record<string, unknown>);
    }
    throw new Error(`unexpected ${method}`);
  });
  fixture.host.request = request as typeof fixture.host.request;
  const container = document.createElement("div");
  document.body.append(container);
  const view = createPrototypePage()(container, createViewContext(fixture.host, params));
  mounted.push(() => view?.dispose?.());
  return {
    fixture,
    container,
    reads: () => request.mock.calls.filter(([method]) => method === GET).map(([, input]) => input),
    preview: () => container.querySelector<HTMLElement>("[data-test-html-preview]"),
    alert: () => container.querySelector('[role="alert"]')?.textContent,
  };
}

it("reads the addressed prototype and renders it through the host preview", async () => {
  const page = mountPrototypePage(
    nodeFilePageTarget(PROTOTYPE_PAGE_ID, { cardId: "card-1", source: { round: 2 }, path: PATH })
      .params ?? {},
  );

  await vi.waitFor(() => expect(page.preview()).not.toBeNull());
  expect(page.reads()).toEqual([{ id: "card-1", round: 2, path: PATH }]);
  expect(page.fixture.host.components.mountHtmlPreview).toHaveBeenCalledWith(
    expect.any(HTMLElement),
    { html: `<p>${PATH}</p>`, title: PATH },
  );
});

it("waits for the connection before reading a live prototype", async () => {
  const page = mountPrototypePage({ card: "card-1", source: "live", path: PATH }, undefined, false);

  expect(page.reads()).toEqual([]);
  expect(page.container.querySelector('[role="status"]')?.textContent).toBe("Loading prototype…");

  page.fixture.connection.connected = true;
  page.fixture.notify();
  await vi.waitFor(() => expect(page.preview()).not.toBeNull());
  expect(page.reads()).toEqual([{ id: "card-1", live: true, path: PATH }]);
});

it.each([
  ["no path", { card: "card-1", source: "live" }],
  ["no card", { source: "0", path: PATH }],
  ["an unknown source", { card: "card-1", source: "latest", path: PATH }],
])("names an address with %s instead of reading", async (_name, params) => {
  const page = mountPrototypePage(params);

  await vi.waitFor(() =>
    expect(page.alert()).toBe(
      "This prototype link needs a card, a source (live or a round number), and a file path. Open it again from the card's Prototype tab.",
    ),
  );
  expect(page.reads()).toEqual([]);
  expect(page.preview()).toBeNull();
});

it("names a failed read", async () => {
  const page = mountPrototypePage({ card: "card-1", source: "live", path: PATH }, async () => {
    throw new Error(`prototype not found: live ${PATH}`);
  });

  await vi.waitFor(() =>
    expect(page.alert()).toBe(`Could not load this prototype: prototype not found: live ${PATH}`),
  );
  expect(page.preview()).toBeNull();
});

it("names a failed read without a reason", async () => {
  const page = mountPrototypePage({ card: "card-1", source: "live", path: PATH }, async () => {
    throw new Error("");
  });

  await vi.waitFor(() =>
    expect(page.alert()).toBe("Could not load this prototype: the Gateway gave no reason"),
  );
});

it("parses the address the Prototype tab builds", () => {
  for (const source of [
    { live: true } as const,
    { base: true } as const,
    { round: 0 },
    { round: 12 },
  ]) {
    const target = { cardId: "card-1", source, path: PATH };
    expect(parseNodeFileTarget(nodeFilePageTarget(PROTOTYPE_PAGE_ID, target).params ?? {})).toEqual(
      target,
    );
  }
});

it("reads the addressed screenshot from the default branch and shows it at full size", async () => {
  const shot = "docs/screenshots/LIN-2.04/dictation-ipad-B.png";
  const fixture = workboardTestHost();
  fixture.connection.connected = true;
  const request = vi.fn(async (_method: string, _input?: unknown) => ({
    mimeType: "image/png",
    contentBase64: "iVBORw==",
  }));
  fixture.host.request = request as typeof fixture.host.request;
  const container = document.createElement("div");
  document.body.append(container);
  const target = nodeFilePageTarget(SCREENSHOT_PAGE_ID, {
    cardId: "card-1",
    source: { base: true },
    path: shot,
  });
  expect(target).toEqual({
    id: "screenshot",
    params: { card: "card-1", source: "base", path: shot },
  });
  const view = createScreenshotPage()(
    container,
    createViewContext(fixture.host, target.params ?? {}),
  );
  mounted.push(() => view?.dispose?.());

  await vi.waitFor(() => expect(container.querySelector("img")).not.toBeNull());
  expect(request.mock.calls).toEqual([
    ["workboard.cards.screenshots.get", { id: "card-1", base: true, path: shot }],
  ]);
  const image = container.querySelector("img");
  expect(image?.getAttribute("src")).toBe("data:image/png;base64,iVBORw==");
  expect(image?.getAttribute("alt")).toBe(shot);
});
