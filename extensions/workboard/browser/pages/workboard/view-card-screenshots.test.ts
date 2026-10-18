import "../../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createWorkboardCard } from "../../lib/workboard/test/index-helpers.ts";
import { mountPage } from "./workboard-page.test-support.ts";

const LIST = "workboard.cards.screenshots.list";
const GET = "workboard.cards.screenshots.get";

let blobs = 0;
const revoked: string[] = [];
beforeEach(() => {
  blobs = 0;
  revoked.length = 0;
  vi.stubGlobal(
    "URL",
    class extends URL {
      static override createObjectURL = () => `blob:shot-${++blobs}`;
      static override revokeObjectURL = (url: string) => void revoked.push(url);
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

function changes(to: string) {
  return { from: "a".repeat(40), to, files: [], totals: { files: 1, added: 0, deleted: 0 } };
}

const NODE_TARGET = {
  kind: "node-claude",
  nodeId: "mac-factory",
  repoPath: "/repo",
  worktreesRoot: "/wt",
  hostRepoPath: "/host",
} as const;

function nodeCard(commits: string[], id = "card-1") {
  return createWorkboardCard({
    id,
    status: "review",
    metadata: { automation: { target: NODE_TARGET } },
    rounds: commits.map((commit, round) => ({ round, changes: changes(commit) })),
  });
}

function listed(rounds: Array<{ round: number; commit: string; paths: string[] }>) {
  return { committed: { state: "available", rounds } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function image(params: Record<string, unknown>) {
  return { mimeType: "image/png", contentBase64: btoa(String(params.path)) };
}

function roundOf(paths: string[], commit = "b".repeat(40)) {
  return listed([{ round: 0, commit, paths }]);
}

type Handler = (params: Record<string, unknown>) => unknown;

/** A connected page with one node ticket's drawer open on the Screenshots tab. */
function screenshotsPage(
  handlers: { list: Handler; get: Handler },
  cards = [nodeCard(["b".repeat(40)])],
) {
  const page = mountPage();
  const fallback = expectDefined(page.request.getMockImplementation(), "request implementation");
  page.request.mockImplementation(async (method, params) => {
    const input = (params ?? {}) as Record<string, unknown>;
    if (method === LIST) {
      return handlers.list(input);
    }
    if (method === GET) {
      return handlers.get(input);
    }
    return fallback(method, params);
  });
  page.cards(cards);
  page.workboard.state.detailCardId = "card-1";
  page.workboard.state.detailTab = "screenshots";
  const setConnected = (connected: boolean) => {
    page.fixture.connection.connected = connected;
    page.fixture.notify();
  };
  setConnected(true);
  return {
    ...page,
    setConnected,
    calls: (method: string) => page.request.mock.calls.filter(([name]) => name === method),
    tab: () => page.container.querySelector("#workboard-detail-tab-screenshots"),
    panel: () => page.container.querySelector<HTMLElement>("#workboard-detail-panel-screenshots"),
    images: () =>
      page.container.querySelectorAll("#workboard-detail-panel-screenshots:not([hidden]) img")
        .length,
  };
}

it("shows a Screenshots tab with each round's images, pairing light and dark captures", async () => {
  const paths = [
    "docs/screenshots/T-1/card-dark.png",
    "docs/screenshots/T-1/card-light.png",
    "docs/screenshots/T-1/spinner.png",
  ];
  const page = screenshotsPage({ list: () => roundOf(paths), get: image });

  await vi.waitFor(() =>
    expect(page.container.querySelectorAll(".workboard-screenshot img")).toHaveLength(3),
  );
  const figures = [...page.container.querySelectorAll(".workboard-screenshot")];
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
  expect(page.request).toHaveBeenCalledWith(GET, {
    id: "card-1",
    round: 0,
    path: "docs/screenshots/T-1/spinner.png",
  });
});

it("lists only committed rounds, and nothing for a node ticket without an imported round", async () => {
  const page = screenshotsPage({ list: () => roundOf(["docs/a.png"]), get: image }, [
    nodeCard(["b".repeat(40)]),
    nodeCard([], "card-2"),
  ]);
  await vi.waitFor(() => expect(page.images()).toBe(1));
  expect(page.calls(LIST).map(([, params]) => params)).toEqual([{ id: "card-1", live: false }]);

  page.workboard.state.detailCardId = "card-2";
  page.workboard.notify();
  await vi.waitFor(() =>
    expect(
      page.container.querySelector("#workboard-detail-tab-overview")?.getAttribute("aria-selected"),
    ).toBe("true"),
  );
  expect(page.calls(LIST)).toHaveLength(1);
});

it("reads no image until the Screenshots tab is opened", async () => {
  const page = screenshotsPage({ list: () => roundOf(["docs/a.png"]), get: image });
  page.workboard.state.detailTab = "overview";
  page.workboard.notify();

  await vi.waitFor(() => expect(page.tab()).not.toBeNull());
  expect(page.calls(GET)).toHaveLength(0);
});

it("keeps the tab hidden when no round committed an image", async () => {
  const listing = deferred<unknown>();
  const page = screenshotsPage({ list: () => listing.promise, get: image });
  await vi.waitFor(() => expect(page.calls(LIST)).toHaveLength(1));
  const settled = expectDefined(page.request.mock.results.at(-1), "listing").value;

  listing.resolve(listed([]));
  // The view's reaction to the listing was registered before this await.
  await settled;
  page.workboard.notify();
  await vi.waitFor(() =>
    expect(
      page.container.querySelector("#workboard-detail-tab-overview")?.getAttribute("aria-selected"),
    ).toBe("true"),
  );
  expect(page.tab()).toBeNull();
});

it("reads at most three screenshots at a time", async () => {
  const paths = Array.from({ length: 8 }, (_, index) => `docs/shot-${index}.png`);
  const reads: Array<ReturnType<typeof deferred<unknown>>> = [];
  const page = screenshotsPage({
    list: () => roundOf(paths),
    get: () => {
      const read = deferred<unknown>();
      reads.push(read);
      return read.promise;
    },
  });

  await vi.waitFor(() =>
    expect(page.container.querySelectorAll(".workboard-screenshot__placeholder")).toHaveLength(8),
  );
  expect(page.calls(GET)).toHaveLength(3);

  reads[0]!.resolve(image({ path: paths[0] }));
  await vi.waitFor(() => expect(page.calls(GET)).toHaveLength(4));
  reads[1]!.reject(new Error("gone"));
  await vi.waitFor(() => expect(page.calls(GET)).toHaveLength(5));
  expect(page.calls(GET).map(([, params]) => (params as { path: string }).path)).toEqual(
    paths.slice(0, 5),
  );
});

it("lists and reads again after a reconnect instead of keeping a failure", async () => {
  let listFails = true;
  let readFails = true;
  const page = screenshotsPage({
    list: () => {
      if (listFails) {
        throw new Error("gateway hiccup");
      }
      return roundOf(["docs/a.png"]);
    },
    get: (params) => {
      if (readFails) {
        throw new Error("gateway hiccup");
      }
      return image(params);
    },
  });
  await vi.waitFor(() => expect(page.panel()?.textContent).toContain("gateway hiccup"));

  listFails = false;
  page.setConnected(false);
  page.setConnected(true);
  await vi.waitFor(() => expect(page.panel()?.textContent).toContain("Could not load this image"));

  readFails = false;
  page.setConnected(false);
  page.setConnected(true);
  await vi.waitFor(() => expect(page.images()).toBe(1));
  expect(page.calls(LIST)).toHaveLength(3);
});

it("revokes the drawer's image URLs when it closes", async () => {
  const page = screenshotsPage({ list: () => roundOf(["docs/a.png", "docs/b.png"]), get: image });
  await vi.waitFor(() => expect(page.images()).toBe(2));

  page.workboard.state.detailCardId = null;
  page.workboard.notify();
  await vi.waitFor(() => expect(revoked.toSorted()).toEqual(["blob:shot-1", "blob:shot-2"]));
});

it("keeps the Screenshots tab open while a new round's import reloads the list", async () => {
  const first = "b".repeat(40);
  const second = "c".repeat(40);
  const relisted = deferred<unknown>();
  const page = screenshotsPage({
    list: () => (page.calls(LIST).length === 1 ? roundOf(["docs/a.png"], first) : relisted.promise),
    get: image,
  });
  await vi.waitFor(() => expect(page.images()).toBe(1));

  page.cards([nodeCard([first, second])]);
  page.fixture.emit("plugin.workboard.changed", { epoch: "cards", revision: 2 });
  await vi.waitFor(() => expect(page.calls(LIST)).toHaveLength(2));
  expect(page.tab()?.getAttribute("aria-selected")).toBe("true");
  expect(page.images()).toBe(1);

  relisted.resolve(
    listed([
      { round: 0, commit: first, paths: ["docs/a.png"] },
      { round: 1, commit: second, paths: ["docs/b.png"] },
    ]),
  );
  await vi.waitFor(() => expect(page.images()).toBe(2));
  expect(page.calls(GET)).toHaveLength(2);
});

it("revokes, and never shows, an image that arrives after its connection dropped", async () => {
  const late = deferred<unknown>();
  const page = screenshotsPage({
    list: () => roundOf(["docs/a.png"]),
    get: (params) => (page.calls(GET).length === 1 ? late.promise : image(params)),
  });
  await vi.waitFor(() => expect(page.calls(GET)).toHaveLength(1));

  page.setConnected(false);
  late.resolve(image({ path: "docs/a.png" }));
  await vi.waitFor(() => expect(revoked).toEqual(["blob:shot-1"]));
  expect(page.container.querySelector("img")).toBeNull();

  page.setConnected(true);
  await vi.waitFor(() => expect(page.images()).toBe(1));
  expect(page.panel()?.querySelector("img")?.getAttribute("src")).toBe("blob:shot-2");
});

it("shows only the open card's screenshots when another card's list arrives late", async () => {
  const firstList = deferred<unknown>();
  const page = screenshotsPage(
    {
      list: (params) =>
        params.id === "card-1" ? firstList.promise : roundOf(["docs/b.png"], "c".repeat(40)),
      get: image,
    },
    [nodeCard(["b".repeat(40)]), nodeCard(["c".repeat(40)], "card-2")],
  );
  await vi.waitFor(() => expect(page.calls(LIST)).toHaveLength(1));

  page.workboard.state.detailCardId = "card-2";
  page.workboard.notify();
  await vi.waitFor(() => expect(page.images()).toBe(1));
  firstList.resolve(roundOf(["docs/a.png"]));
  await firstList.promise;
  page.workboard.notify();

  await vi.waitFor(() =>
    expect(page.panel()?.querySelector("img")?.getAttribute("alt")).toBe("b.png"),
  );
  expect(page.calls(GET).map(([, params]) => (params as { id: string }).id)).toEqual(["card-2"]);
  expect(page.panel()?.textContent).not.toContain("a.png");
});

it("keeps the tab open on a manual refresh and retries a failed image", async () => {
  let readFails = true;
  const relisted = deferred<unknown>();
  const page = screenshotsPage({
    list: () => (page.calls(LIST).length === 1 ? roundOf(["docs/a.png"]) : relisted.promise),
    get: (params) => {
      if (readFails) {
        throw new Error("gateway hiccup");
      }
      return image(params);
    },
  });
  await vi.waitFor(() => expect(page.panel()?.textContent).toContain("Could not load this image"));

  readFails = false;
  page.container.querySelector<HTMLButtonElement>(".workboard-refresh")?.click();
  await vi.waitFor(() => expect(page.calls(LIST)).toHaveLength(2));
  expect(page.tab()?.getAttribute("aria-selected")).toBe("true");
  relisted.resolve(roundOf(["docs/a.png"]));
  await vi.waitFor(() => expect(page.images()).toBe(1));
});
