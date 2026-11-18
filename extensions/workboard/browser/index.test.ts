import "./test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import type {
  ControlUiAccessory,
  ControlUiNavigationItem,
  ControlUiPage,
} from "openclaw/plugin-sdk/control-ui";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import workboardPlugin from "./index.ts";
import { createGatewaySession, createWorkboardCard } from "./lib/workboard/test/index-helpers.ts";
import type { WorkboardBoardSummary } from "./lib/workboard/types.ts";
import { workboardTestHost } from "./test/host.setup.ts";
import { createViewContext } from "./test/host.ts";

let fixture: ReturnType<typeof workboardTestHost>;
let stopPlugin: (() => void) | undefined;
let stopView: (() => void) | undefined;
let request: ReturnType<typeof vi.fn<(method: string, params: unknown) => Promise<unknown>>>;
beforeEach(() => {
  vi.useFakeTimers();
  fixture = workboardTestHost();
  fixture.connection.connected = true;
  request = vi.fn();
  fixture.host.request = request as typeof fixture.host.request;
});
afterEach(() => {
  dispose();
  vi.useRealTimers();
});

function dispose() {
  stopView?.();
  stopView = undefined;
  stopPlugin?.();
  stopPlugin = undefined;
}
async function activate() {
  stopPlugin = (await workboardPlugin.activate(fixture.host)) ?? undefined;
  await tick();
}
const tick = () => vi.advanceTimersByTimeAsync(0);
const query = (selector: string) =>
  expectDefined(document.querySelector<HTMLElement>(selector), selector);
const navigation = (id: string) =>
  fixture.registrations.get(`navigation/board-${id}`) as ControlUiNavigationItem;
const deleteAction = () =>
  expectDefined(
    navigation("ops").actions?.find(({ id }) => id === "delete"),
    "delete action",
  );
const registeredKeys = (prefix: string) =>
  [...fixture.registrations.keys()].filter((key) => key.startsWith(prefix));
const deleteCalls = () =>
  request.mock.calls.filter(([method]) => method === "workboard.boards.delete");
const dialogButton = (confirm: boolean) =>
  expectDefined(
    document.querySelector<HTMLButtonElement>(
      `[data-test-dialog] ${confirm ? ".danger" : "button:not(.danger)"}`,
    ),
    "dialog button",
  );
const clickDialog = (confirm: boolean) => dialogButton(confirm).click();
const expectError = (message: string) =>
  expect(query("[role=alert]").textContent).toContain(message);
async function change(payload: unknown = {}) {
  fixture.emit("plugin.workboard.changed", payload);
  await tick();
}
async function mountPage(props: Record<string, string>) {
  const container = document.body.appendChild(document.createElement("div"));
  const page = fixture.registrations.get("page/workboard") as ControlUiPage;
  const mounted = page.mount(container, createViewContext(fixture.host, props));
  stopView = () => mounted?.dispose?.();
  const update = (next: Record<string, string>, presented = true) =>
    mounted?.update?.(createViewContext(fixture.host, next, presented));
  await vi.dynamicImportSettled();
  update(props);
  await tick();
  return { container, update };
}
function mountAccessory(session: ReturnType<typeof createGatewaySession>) {
  const container = document.createElement("div");
  const accessory = fixture.registrations.get("accessory/linked-card") as ControlUiAccessory;
  const mounted = accessory.mount(
    container,
    createViewContext(fixture.host, { sessionKey: session.key, session }),
  );
  stopView = () => mounted?.dispose?.();
  return container;
}

const makeBoard = (id: string, extra: Partial<WorkboardBoardSummary> = {}) => ({ id, ...extra });

it("refreshes catalog labels when a deferred locale loads and when the locale changes", async () => {
  Object.assign(fixture.host, { locale: "sv" });
  request.mockResolvedValue({ boards: [makeBoard("default")] });
  await activate();
  await vi.dynamicImportSettled();
  await tick();
  expect(navigation("default").label).toBe("Standardtavla");

  Object.assign(fixture.host, { locale: "en" });
  fixture.notify();
  await tick();
  expect(navigation("default").label).toBe("Default board");
  // Activation probes the fork's viewer pages once; a locale change refetches nothing.
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    "workboard.transcriptViewer",
    "workboard.officeViewer",
    "workboard.architectureViewer",
    "workboard.boards.list",
  ]);

  Object.assign(fixture.host, { locale: "sv" });
  fixture.notify();
  dispose();
  await tick();
  expect(fixture.registrations.has("navigation/board-default")).toBe(false);
});
function navigationItem(id: string, label: string, icon?: string) {
  return {
    id: `board-${id}`,
    parent: "workboard",
    label,
    defaultVisible: false,
    page: { id: "workboard", path: [id] },
    ...(icon ? { icon } : {}),
  };
}
const columns: NonNullable<WorkboardBoardSummary["sessions"]>["columns"] = [
  { id: "working", label: "Working", description: "Active work", match: { run: ["active"] } },
  { id: "done", label: "Done", description: "Completed work", fallback: true },
];
const sessionsBoard = (name: string) =>
  makeBoard("sessions", { name, kind: "sessions", sessions: { columns } });

it("keeps catalog navigation ordered and disambiguates names only while boards share them", async () => {
  const { host, connection, registrations } = fixture;
  const operations = makeBoard("ops", { name: "Zebra", icon: "rocket", color: "blue" });
  const sessions = sessionsBoard("Alpha");
  let boards = [operations, sessions];
  request.mockImplementation(async () => ({ cards: [], boards }));
  const register = vi.spyOn(host.ui, "registerNavigation");
  await activate();
  const boardNavigation = () =>
    [...registrations.entries()]
      .filter(([key]) => key.startsWith("navigation/board-"))
      .map(([, item]) => item as ControlUiNavigationItem)
      .toSorted((left, right) => (left.order ?? 0) - (right.order ?? 0));
  async function showBoards(next: typeof boards, labels: string[]) {
    boards = next;
    await change();
    expect(boardNavigation().map(({ label }) => label)).toEqual(labels);
  }
  expect(boardNavigation()).toMatchObject([
    navigationItem("ops", "Zebra", "rocket"),
    navigationItem("sessions", "Alpha"),
  ]);
  for (const item of boardNavigation()) {
    expect(item.actions).toMatchObject([
      { id: "pin", label: "Pin to sidebar" },
      { id: "delete", label: "Delete board…", destructive: true },
    ]);
  }
  const operationsNavigation = expectDefined(boardNavigation()[0], "Operations navigation");
  await expectDefined(operationsNavigation.actions?.[0], "pin action").run();
  expect(host.ui.pinNavigation).toHaveBeenCalledExactlyOnceWith("board-ops");
  vi.mocked(host.ui.pinNavigation).mockClear();
  vi.mocked(host.ui.isNavigationPinned).mockReturnValue(true);
  const unpin = expectDefined(operationsNavigation.actions?.[0], "unpin action");
  expect(unpin.label).toBe("Unpin from sidebar");
  await unpin.run();
  expect(host.ui.unpinNavigation).toHaveBeenCalledExactlyOnceWith("board-ops");
  connection.canWrite = false;
  expect(operationsNavigation.actions?.map(({ id }) => id)).toEqual(["pin"]);
  connection.canWrite = true;
  register.mockClear();
  await change();
  expect(register).not.toHaveBeenCalled();

  await showBoards(
    [sessions, { ...operations, name: "Alpha", icon: "kanban", color: "green" }],
    ["Alpha (sessions)", "Alpha (cards)"],
  );
  expect(boardNavigation().map(({ id }) => id)).toEqual(["board-sessions", "board-ops"]);
  expect(navigation("ops").icon).toBe("kanban");

  await showBoards([sessions, { ...operations, name: "Operations" }], ["Alpha", "Operations"]);
  await showBoards([sessions], ["Alpha"]);
  expect(boardNavigation().map(({ id }) => id)).toEqual(["board-sessions"]);
  expect(host.ui.pinNavigation).not.toHaveBeenCalled();
  dispose();
  expect(registeredKeys("navigation/")).toEqual([]);
});

it.each(["open", "another board", "hidden"] as const)(
  "deletes a board after confirmation without leaving a %s page incorrectly",
  async (presentation) => {
    const { host, registrations } = fixture;
    let boards = [makeBoard("ops", { name: "Operations" }), makeBoard("other")];
    const deleted = createDeferred<{ deleted: boolean }>();
    const stale = createDeferred<{ cards: never[]; boards: typeof boards }>();
    let pendingCatalog: typeof stale.promise | undefined;
    request.mockImplementation(async (method: string) => {
      if (method === "workboard.boards.delete") {
        return deleted.promise;
      }
      if (method === "workboard.boards.list" && pendingCatalog) {
        const pending = pendingCatalog;
        pendingCatalog = undefined;
        return pending;
      }
      return { cards: [], boards };
    });
    await activate();
    const { update } = await mountPage({ boardId: "ops" });
    const previousBoards = boards;
    if (presentation === "open") {
      pendingCatalog = stale.promise;
      await change();
    }
    const pending = deleteAction().run();
    expect(query("[data-test-dialog]").getAttribute("aria-label")).toBe("Delete “Operations”?");
    expect(deleteCalls()).toHaveLength(0);
    clickDialog(true);
    expect(request).toHaveBeenCalledWith("workboard.boards.delete", { id: "ops" });
    expect(host.ui.unpinNavigation).not.toHaveBeenCalled();
    if (presentation !== "open") {
      update(
        { boardId: presentation === "another board" ? "other" : "ops" },
        presentation !== "hidden",
      );
    }
    boards = boards.filter(({ id }) => id !== "ops");
    deleted.resolve({ deleted: true });
    await pending;
    await vi.advanceTimersByTimeAsync(0);
    stale.resolve({ cards: [], boards: previousBoards });
    await vi.advanceTimersByTimeAsync(0);
    expect(host.ui.unpinNavigation).toHaveBeenCalledExactlyOnceWith("board-ops");
    expect(registrations.has("navigation/board-ops")).toBe(false);
    expect(document.querySelector("[data-test-dialog]")).toBeNull();
    if (presentation === "open") {
      expect(host.navigation.openPage).toHaveBeenCalledExactlyOnceWith(
        { id: "workboard", path: [] },
        { replace: true, preserveSearch: true },
      );
    } else {
      expect(host.navigation.openPage).not.toHaveBeenCalled();
    }
  },
);

it("keeps a board and its pin when deletion is canceled, refused, or fails", async () => {
  const { host, connection, registrations } = fixture;
  const operations = makeBoard("ops", { name: "Operations" });
  request.mockImplementation(async (method: string) => {
    if (method === "workboard.boards.delete") {
      throw new Error("board still has cards; archive it or move/delete the cards first.");
    }
    return { cards: [], boards: [operations] };
  });
  await activate();
  const action = deleteAction();
  const cancel = action.run();
  clickDialog(false);
  await cancel;
  const pending = action.run();
  connection.canWrite = false;
  clickDialog(true);
  await vi.advanceTimersByTimeAsync(0);
  expectError("Connect with write access");
  expect(deleteCalls()).toHaveLength(0);
  connection.canWrite = true;
  clickDialog(true);
  await vi.advanceTimersByTimeAsync(0);
  expectError("board still has cards");
  const confirm = dialogButton(true);
  const retry = createDeferred<unknown>();
  request.mockImplementationOnce(() => retry.promise);
  confirm.click();
  confirm.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(deleteCalls()).toHaveLength(2);
  expect(document.querySelector("[role=alert]")).toBeNull();
  expect(confirm.disabled).toBe(true);
  expect(dialogButton(false).disabled).toBe(true);
  const cancelEvent = new Event("cancel", { cancelable: true });
  query("[data-test-dialog]").dispatchEvent(cancelEvent);
  expect(cancelEvent.defaultPrevented).toBe(true);
  retry.reject(new Error("Retry deletion failed"));
  await vi.advanceTimersByTimeAsync(0);
  expectError("Retry deletion failed");
  expect(dialogButton(true)).toBe(confirm);
  expect(confirm.disabled).toBe(false);
  expect(registrations.has("navigation/board-ops")).toBe(true);
  expect(host.ui.unpinNavigation).not.toHaveBeenCalled();
  expect(host.navigation.openPage).not.toHaveBeenCalled();
  clickDialog(false);
  await pending;
});

it("disambiguates a created board and its sibling before pinning through a stale catalog completion", async () => {
  const { host, registrations } = fixture;
  const board = { id: "created", name: "Created", icon: "rocket", createdAt: 1, updatedAt: 1 };
  const existing = sessionsBoard("Created");
  const stale = createDeferred<unknown>();
  const refreshed = createDeferred<unknown>();
  const read = vi.fn<() => Promise<unknown>>().mockResolvedValue({ cards: [], boards: [existing] });
  request.mockImplementation(async (method: string) => {
    if (method === "workboard.boards.upsert") {
      read.mockReturnValue(refreshed.promise);
      return { board };
    }
    if (method === "workboard.cards.list" || method === "workboard.boards.list") {
      return read();
    }
    return {};
  });
  let pinnedNavigation: unknown;
  let siblingAtPin: unknown;
  vi.mocked(host.ui.pinNavigation).mockImplementation((id) => {
    pinnedNavigation = registrations.get(`navigation/${id}`);
    siblingAtPin = registrations.get("navigation/board-sessions");
  });
  const register = vi.spyOn(host.ui, "registerNavigation");
  await activate();
  const { container } = await mountPage({});
  expect(registrations.get("navigation/board-sessions")).toMatchObject({ label: "Created" });
  expectDefined(
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "New board",
    ),
    "new board button",
  ).click();
  await vi.advanceTimersByTimeAsync(0);
  read.mockReturnValue(stale.promise);
  fixture.emit("plugin.workboard.changed", {});
  const form = expectDefined(
    container.querySelector<HTMLFormElement>(".workboard-board-draft"),
    "draft form",
  );
  const name = expectDefined(
    form.querySelector<HTMLInputElement>(".workboard-board-draft__name input"),
    "draft name",
  );
  name.value = board.name;
  name.dispatchEvent(new Event("input", { bubbles: true }));
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(0);
  expect(host.ui.pinNavigation).toHaveBeenCalledExactlyOnceWith("board-created");
  expect(pinnedNavigation).toMatchObject(navigationItem("created", "Created (cards)", "rocket"));
  expect(siblingAtPin).toMatchObject({ label: "Created (sessions)" });

  stale.resolve({ cards: [], boards: [existing] });
  await vi.advanceTimersByTimeAsync(0);
  expect(registrations.get("navigation/board-created")).toBe(pinnedNavigation);
  refreshed.resolve({ cards: [], boards: [existing, board] });
  await vi.advanceTimersByTimeAsync(0);
  register.mockClear();
  await change();
  expect(register).not.toHaveBeenCalled();
  expect(host.ui.pinNavigation).toHaveBeenCalledOnce();
});

it("avoids accessory polling, recovers failed reads, and retires pending reads", async () => {
  const hostListeners = fixture.listeners.size;
  const { host } = fixture;
  const session = createGatewaySession();
  const card = createWorkboardCard({ title: "Linked card", sessionKey: session.key });
  const boards = [makeBoard("default")];
  let currentCard = card;
  const read = vi.fn<() => Promise<unknown>>(async () => ({ cards: [currentCard] }));
  request.mockImplementation(async (method: string) =>
    method === "workboard.boards.list" ? { boards } : read(),
  );
  await activate();
  const container = mountAccessory(session);
  await vi.advanceTimersByTimeAsync(0);
  expect(container.textContent).toContain(card.title);
  expect(registeredKeys("action/")).toEqual([]);
  const expectedCalls = [
    ["workboard.transcriptViewer", {}],
    ["workboard.officeViewer", {}],
    ["workboard.architectureViewer", {}],
    ["workboard.boards.list", {}],
    ["workboard.cards.list", { sessionKey: session.key }],
  ];
  await vi.advanceTimersByTimeAsync(15 * 60_000);
  expect(request.mock.calls).toEqual(expectedCalls);

  read.mockRejectedValueOnce(new Error("Temporary read failure"));
  await change({ epoch: "catalog-epoch", revision: 1 });
  expect(request.mock.settledResults.some((result) => result.type === "rejected")).toBe(true);
  expect(container.textContent).toContain(card.title);

  currentCard = { ...card, metadata: { archivedAt: 1 } };
  await change();
  expect(container.querySelector("a")).toBeNull();

  currentCard = card;
  await change();
  expect(container.textContent).toContain(card.title);

  const pending = createDeferred<unknown>();
  read.mockReturnValueOnce(pending.promise);
  await change();
  const count = request.mock.calls.length;
  dispose();
  const invalidations = vi.mocked(host.ui.invalidate).mock.calls.length;
  pending.resolve({ cards: [{ ...card, title: "Retired response" }] });
  await vi.advanceTimersByTimeAsync(0);
  fixture.emit("plugin.workboard.changed", {});
  fixture.notify();
  expect(request).toHaveBeenCalledTimes(count);
  expect(vi.mocked(host.ui.invalidate).mock.calls.length).toBe(invalidations);
  expect(container.childElementCount).toBe(0);
  expect(fixture.events.get("plugin.workboard.changed")?.size).toBe(0);
  expect(fixture.listeners.size).toBe(hostListeners);
});

it.each([17317, null])(
  "adds the Transcripts page only when the Gateway serves a viewer port (%s)",
  async (port) => {
    vi.useFakeTimers();
    const { host, connection, registrations } = workboardTestHost();
    connection.connected = true;
    const viewerRequest = vi.fn(async (method: string) =>
      method === "workboard.transcriptViewer"
        ? { port }
        : method === "portal.open"
          ? { tokenQuery: "openclaw_portal=token", publicUrl: "https://gateway.example:35535/" }
          : { cards: [], boards: [] },
    );
    host.request = viewerRequest as typeof host.request;
    const tab = { opener: window as Window | null, location: { href: "" }, close: vi.fn() };
    const open = vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    const stop = await workboardPlugin.activate(host);
    try {
      await vi.advanceTimersByTimeAsync(0);
      if (port === null) {
        expect(registrations.has("navigation/transcripts")).toBe(false);
        expect(registrations.has("page/transcripts")).toBe(false);
        return;
      }
      expect(registrations.get("navigation/transcripts")).toMatchObject({
        parent: "workboard",
        label: "Transcripts",
        page: { id: "transcripts" },
      });
      const page = registrations.get("page/transcripts") as ControlUiPage;
      const container = document.createElement("div");
      page.mount(container, createViewContext(host, {}));
      expectDefined(container.querySelector("button"), "viewer button").click();
      await vi.advanceTimersByTimeAsync(0);
      expect(viewerRequest).toHaveBeenCalledWith("portal.open", { port, title: "Transcripts" });
      expect(tab.location.href).toBe("https://gateway.example:35535/?openclaw_portal=token");
    } finally {
      open.mockRestore();
      stop?.();
    }
    expect(registrations.has("navigation/transcripts")).toBe(false);
  },
);

function transcriptViewerHost(viewer: () => Promise<{ port: number | null }>) {
  vi.useFakeTimers();
  const viewerHost = workboardTestHost();
  const transcriptViewer = vi.fn(viewer);
  const viewerRequest = vi.fn(async (method: string) =>
    method === "workboard.transcriptViewer" ? transcriptViewer() : { cards: [], boards: [] },
  );
  viewerHost.host.request = viewerRequest as typeof viewerHost.host.request;
  const transcripts = () => [
    viewerHost.registrations.has("page/transcripts"),
    viewerHost.registrations.has("navigation/transcripts"),
  ];
  return { ...viewerHost, viewerRequest, transcriptViewer, transcripts };
}

it("shows the Transcripts page only while the operator can write", async () => {
  const viewerHost = transcriptViewerHost(async () => ({ port: 17317 }));
  viewerHost.connection.connected = true;
  viewerHost.connection.canWrite = false;
  const stop = await workboardPlugin.activate(viewerHost.host);
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(viewerHost.transcriptViewer).toHaveBeenCalledOnce();
    expect(viewerHost.transcripts()).toEqual([false, false]);

    viewerHost.connection.canWrite = true;
    viewerHost.notify();
    expect(viewerHost.transcripts()).toEqual([true, true]);

    viewerHost.connection.canWrite = false;
    viewerHost.notify();
    expect(viewerHost.transcripts()).toEqual([false, false]);

    viewerHost.connection.canWrite = true;
    viewerHost.notify();
    expect(viewerHost.transcripts()).toEqual([true, true]);
    expect(viewerHost.transcriptViewer).toHaveBeenCalledOnce();
  } finally {
    stop?.();
  }
  expect(viewerHost.transcripts()).toEqual([false, false]);
});

it("reads the transcript viewer port once the Gateway connects", async () => {
  const viewerHost = transcriptViewerHost(async () => ({ port: 17317 }));
  viewerHost.connection.connected = false;
  const stop = await workboardPlugin.activate(viewerHost.host);
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(viewerHost.viewerRequest).not.toHaveBeenCalled();
    expect(viewerHost.transcripts()).toEqual([false, false]);

    viewerHost.connection.connected = true;
    viewerHost.notify();
    await vi.advanceTimersByTimeAsync(0);
    expect(viewerHost.transcriptViewer).toHaveBeenCalledOnce();
    expect(viewerHost.transcripts()).toEqual([true, true]);
  } finally {
    stop?.();
  }
});

it("asks for the transcript viewer port again after a failed read", async () => {
  const viewerHost = transcriptViewerHost(async () => ({ port: 17317 }));
  viewerHost.transcriptViewer.mockRejectedValueOnce(new Error("Temporary read failure"));
  viewerHost.connection.connected = true;
  const stop = await workboardPlugin.activate(viewerHost.host);
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(viewerHost.transcriptViewer).toHaveBeenCalledOnce();
    expect(viewerHost.transcripts()).toEqual([false, false]);

    viewerHost.notify();
    await vi.advanceTimersByTimeAsync(0);
    expect(viewerHost.transcriptViewer).toHaveBeenCalledTimes(2);
    expect(viewerHost.transcripts()).toEqual([true, true]);
  } finally {
    stop?.();
  }
});

it("ignores a transcript viewer port that arrives after the activation ends", async () => {
  const viewer = createDeferred<{ port: number | null }>();
  const viewerHost = transcriptViewerHost(() => viewer.promise);
  viewerHost.connection.connected = true;
  const stop = await workboardPlugin.activate(viewerHost.host);
  expect(viewerHost.transcriptViewer).toHaveBeenCalledOnce();
  stop?.();
  viewerHost.dispose();

  viewer.resolve({ port: 17317 });
  await vi.advanceTimersByTimeAsync(0);
  expect(viewerHost.transcripts()).toEqual([false, false]);
});

it("shows the Office page only while the operator can write, and embeds a portal frame", async () => {
  vi.useFakeTimers();
  const { host, connection, registrations, notify } = workboardTestHost();
  connection.connected = true;
  connection.canWrite = false;
  const viewerRequest = vi.fn(async (method: string) =>
    method === "workboard.officeViewer"
      ? { port: 17320 }
      : method === "portal.open"
        ? { tokenQuery: "openclaw_portal=token", publicUrl: "https://gateway.example:35535/" }
        : { cards: [], boards: [] },
  );
  host.request = viewerRequest as typeof host.request;
  const stop = await workboardPlugin.activate(host);
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(registrations.has("navigation/office")).toBe(false);

    connection.canWrite = true;
    notify();
    expect(registrations.get("navigation/office")).toMatchObject({
      parent: "workboard",
      label: "Office",
      page: { id: "office" },
    });
    const page = registrations.get("page/office") as ControlUiPage;
    const container = document.createElement("div");
    page.mount(container, createViewContext(host, {}));
    await vi.advanceTimersByTimeAsync(0);
    expect(viewerRequest).toHaveBeenCalledWith("portal.open", { port: 17320, title: "Office" });
    expect(container.querySelector("iframe")?.getAttribute("src")).toBe(
      "https://gateway.example:35535/?openclaw_portal=token",
    );

    connection.canWrite = false;
    notify();
    expect(registrations.has("navigation/office")).toBe(false);
  } finally {
    stop?.();
  }
});

it("loads the architecture viewer port without adding a page for it", async () => {
  vi.useFakeTimers();
  const { host, connection, registrations } = workboardTestHost();
  connection.connected = true;
  const viewerRequest = vi.fn(async (method: string) =>
    method === "workboard.architectureViewer" ? { port: 17318 } : { cards: [], boards: [] },
  );
  host.request = viewerRequest as typeof host.request;
  const stop = await workboardPlugin.activate(host);
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(viewerRequest).toHaveBeenCalledWith("workboard.architectureViewer", {});
    expect(registrations.has("page/architecture")).toBe(false);
    expect(registrations.has("navigation/architecture")).toBe(false);
  } finally {
    stop?.();
  }
});
