import "./test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi } from "vitest";
import { createWorkboardCapability } from "./lib/workboard/capability.ts";
import { createWorkboardCard } from "./lib/workboard/test/index-helpers.ts";
import { createWorkboardPage } from "./pages/workboard/workboard-page.tsx";
import { createWorkboardSessionAccessory } from "./session-accessory.tsx";
import { workboardTestHost } from "./test/host.setup.ts";
import { createViewContext } from "./test/host.ts";

it("reveals a reassigned linked card without changing the selected chat agent", async () => {
  const { host, connection } = workboardTestHost();
  connection.connected = true;
  Object.assign(host.agents, {
    rows: [{ id: "main" }, { id: "writer" }],
    defaultId: "main",
    selectedId: "writer",
    scopeId: "writer",
  });
  const sessionKey = "agent:writer:dashboard:1";
  const card = createWorkboardCard({
    title: "Reassigned writer conversation",
    agentId: "main",
    sessionKey,
    metadata: { automation: { boardId: "ops" } },
  });
  const request = vi.fn(async (method: string) =>
    method === "workboard.cards.list"
      ? {
          cards: [card],
          boards: [{ id: "ops", total: 1, active: 1, archived: 0, byStatus: { todo: 1 } }],
        }
      : { tasks: [] },
  );
  host.request = request as typeof host.request;
  const workboard = createWorkboardCapability();
  workboard.state.scopeAgentId = "writer";
  const container = document.createElement("div");
  const destination = document.createElement("div");
  document.body.append(container, destination);
  let disposeDestination = () => {};
  vi.mocked(host.navigation.openPage).mockImplementation(({ path }) => {
    disposeDestination();
    const mounted = createWorkboardPage(
      workboard,
      vi.fn(),
      () => null,
    )(destination, createViewContext(host, { boardId: path?.[0] ?? "__all__" }));
    disposeDestination = () => mounted?.dispose?.();
  });
  const mounted = createWorkboardSessionAccessory(workboard)(
    container,
    createViewContext(host, { sessionKey }),
  );
  try {
    await vi.waitFor(() => expect(container.textContent).toContain(card.title));
    container.querySelector("a")!.click();

    await vi.waitFor(() =>
      expect(destination.querySelector(".workboard-board")?.textContent).toContain(card.title),
    );
    expect(workboard.state.scopeAgentId).toBeNull();
    expect(host.agents.scopeId).toBe("writer");
    expect(host.agents.selectedId).toBe("writer");
  } finally {
    mounted?.dispose?.();
    disposeDestination();
    workboard.dispose();
    container.remove();
    destination.remove();
  }
});

it.each(["global", "unknown"])(
  "does not associate a bare %s card with an ambient pane owner",
  (sessionKey) => {
    const fixture = workboardTestHost();
    fixture.connection.connected = true;
    const container = document.createElement("div");
    const mounted = createWorkboardSessionAccessory(createWorkboardCapability())(
      container,
      createViewContext(fixture.host, { sessionKey, agentId: "writer" }),
    );
    try {
      expect(container.querySelector("a")).toBeNull();
      expect(fixture.host.navigation.openPage).not.toHaveBeenCalled();
    } finally {
      mounted?.dispose?.();
    }
  },
);

it("refreshes only the visible session and ignores stale lookups after navigation", async () => {
  vi.useFakeTimers();
  const fixture = workboardTestHost();
  const initialListeners = new Set(fixture.listeners);
  fixture.connection.connected = true;
  const sessionKey = "agent:main:workboard-card";
  const card = createWorkboardCard({
    title: "Ship dashboard stitch",
    status: "review",
    sessionKey,
  });
  let current = card;
  let revision = 1;
  fixture.host.request = vi.fn(async () => ({
    cards: [current],
    revision: { epoch: "test", revision },
  })) as typeof fixture.host.request;
  const container = document.createElement("div");
  const context = createViewContext(fixture.host, { sessionKey });
  const mounted = createWorkboardSessionAccessory(createWorkboardCapability())(container, context);
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(container.textContent).toContain(card.title);
    fixture.emit("plugin.workboard.changed", { epoch: "test", revision: 2, cardsRevision: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.host.request).toHaveBeenCalledOnce();
    current = { ...card, title: "Renamed" };
    revision = 3;
    fixture.emit("plugin.workboard.changed", { epoch: "test", revision, cardsRevision: revision });
    await vi.advanceTimersByTimeAsync(0);
    expect(container.textContent).toContain("Renamed");
    expect(fixture.host.request).toHaveBeenLastCalledWith("workboard.cards.list", {
      sessionKey,
      sinceRevision: { epoch: "test", revision: 1, sessionKey },
    });
    const pending = createDeferred<unknown>();
    vi.mocked(fixture.host.request).mockReturnValueOnce(pending.promise);
    mounted?.update?.({ ...context, props: { sessionKey: "agent:main:other" } });
    mounted?.update?.({ ...context, presented: false });
    pending.resolve({ cards: [card] });
    await vi.advanceTimersByTimeAsync(0);
    expect(container.querySelector("a")).toBeNull();
    const count = vi.mocked(fixture.host.request).mock.calls.length;
    fixture.emit("plugin.workboard.changed", { epoch: "test", revision: 4 });
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.host.request).toHaveBeenCalledTimes(count);
  } finally {
    mounted?.dispose?.();
    vi.useRealTimers();
  }
  expect(container.childElementCount).toBe(0);
  expect(fixture.listeners).toEqual(initialListeners);
});

it("offers a node ticket's session its Screens panel, and no other session", async () => {
  const { host, connection } = workboardTestHost();
  connection.connected = true;
  const nodeTicket = createWorkboardCard({
    sessionKey: "agent:dev:workboard:node",
    metadata: {
      automation: {
        target: {
          kind: "node-claude",
          nodeId: "mac-factory",
          repoPath: "/repo",
          worktreesRoot: "/wt",
          hostRepoPath: "/host",
        },
      },
    },
  });
  const plain = createWorkboardCard({ id: "card-2", sessionKey: "agent:dev:workboard:plain" });
  host.request = vi.fn(async () => ({ cards: [nodeTicket, plain] })) as typeof host.request;
  const container = document.createElement("div");
  const mount = (sessionKey: string) =>
    createWorkboardSessionAccessory(createWorkboardCapability())(
      container,
      createViewContext(host, { sessionKey }),
    );

  const plainChip = mount("agent:dev:workboard:plain");
  await vi.waitFor(() => expect(container.querySelector(".workboard-session-chip")).not.toBeNull());
  expect(container.querySelector(".workboard-session-screens")).toBeNull();
  plainChip?.dispose?.();

  const nodeChip = mount("agent:dev:workboard:node");
  try {
    const screens = await vi.waitFor(() =>
      expectDefined(
        container.querySelector<HTMLButtonElement>(".workboard-session-screens"),
        "screens button",
      ),
    );
    screens.click();
    expect(host.ui.openPanel).toHaveBeenCalledExactlyOnceWith("screens", {
      sessionKey: "agent:dev:workboard:node",
    });
  } finally {
    nodeChip?.dispose?.();
  }
});

it("says where a grilling card's grilling runs and opens its grill session", async () => {
  const fixture = workboardTestHost();
  fixture.connection.connected = true;
  const sessionKey = "agent:dev:subagent:workboard-platform-card";
  const grillSessionKey = "agent:dev:grill-card-2";
  const card = createWorkboardCard({
    title: "Spec the parser",
    status: "review",
    sessionKey,
    stage: { kind: "grilling", since: 1, round: 2 },
    grill: { status: "open", rounds: 2, attachmentId: "log-1", sessionKey: grillSessionKey },
    metadata: { automation: { boardId: "platform" } },
  });
  fixture.host.request = vi.fn(async () => ({ cards: [card] })) as typeof fixture.host.request;
  const container = document.createElement("div");
  const mounted = createWorkboardSessionAccessory(createWorkboardCapability())(
    container,
    createViewContext(fixture.host, { sessionKey }),
  );
  try {
    await vi.waitFor(() => expect(container.textContent).toContain(card.title));
    const link = container.querySelector("a")!;
    expect(link.querySelector(".workboard-session-chip__status")?.textContent).toBe(
      "Grilling — in Grill Spec the parser",
    );
    link.click();
    expect(fixture.host.sessions.open).toHaveBeenCalledWith({ sessionKey: grillSessionKey });
    expect(fixture.host.navigation.openPage).not.toHaveBeenCalled();
  } finally {
    mounted?.dispose?.();
  }
});
