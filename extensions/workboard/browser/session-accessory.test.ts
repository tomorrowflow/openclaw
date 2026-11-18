import "./test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import { expect, it, onTestFinished, vi } from "vitest";
import { createWorkboardCapability } from "./lib/workboard/capability.ts";
import { createWorkboardCard } from "./lib/workboard/test/index-helpers.ts";
import { createWorkboardPage } from "./pages/workboard/workboard-page.tsx";
import { createWorkboardSessionAccessory } from "./session-accessory.tsx";
import { workboardTestHost } from "./test/host.setup.ts";
import { createViewContext } from "./test/host.ts";

function mountAccessory(
  sessionKey: string,
  payload: unknown = {},
  agentId?: string,
  workboard = createWorkboardCapability(),
) {
  const fixture = workboardTestHost();
  fixture.connection.connected = true;
  const request = vi.fn(async (method: string) =>
    method === "workboard.cards.list" ? payload : { tasks: [] },
  );
  fixture.host.request = request as typeof fixture.host.request;
  const container = document.body.appendChild(document.createElement("div"));
  const context = createViewContext(fixture.host, { sessionKey, ...(agentId ? { agentId } : {}) });
  let mounted = createWorkboardSessionAccessory(workboard)(container, context);
  const dispose = () => {
    mounted?.dispose?.();
    mounted = undefined;
  };
  onTestFinished(dispose);
  return { ...fixture, request, container, context, mounted, dispose };
}

it("reveals a reassigned linked card without changing the selected chat agent", async () => {
  const sessionKey = "agent:writer:dashboard:1";
  const card = createWorkboardCard({
    agentId: "main",
    sessionKey,
    metadata: { automation: { boardId: "ops" } },
  });
  const payload = { cards: [card], boards: [{ id: "ops" }] };
  // The board owns its agent scope; revealing the card clears it and leaves the app-wide scope alone.
  const workboard = createWorkboardCapability();
  onTestFinished(() => workboard.dispose());
  workboard.state.scopeAgentId = "writer";
  const { host, container } = mountAccessory(sessionKey, payload, undefined, workboard);
  Object.assign(host.agents, { selectedId: "writer", scopeId: "writer" });
  const destination = document.body.appendChild(document.createElement("div"));
  let disposeDestination = () => {};
  onTestFinished(() => disposeDestination());
  vi.mocked(host.navigation.openPage).mockImplementation(({ path }) => {
    disposeDestination();
    const mounted = createWorkboardPage(
      workboard,
      vi.fn(),
      () => null,
      () => null,
    )(destination, createViewContext(host, { boardId: path?.[0] ?? "__all__" }));
    disposeDestination = () => mounted?.dispose?.();
  });
  await vi.waitFor(() => expect(container.textContent).toContain(card.title));
  container.querySelector("a")!.click();
  await vi.waitFor(() =>
    expect(destination.querySelector(".workboard-board")?.textContent).toContain(card.title),
  );
  expect(workboard.state.scopeAgentId).toBeNull();
  expect(host.agents).toMatchObject({ scopeId: "writer", selectedId: "writer" });
});

it.each(["global", "unknown"])("ignores bare %s sessions despite an ambient owner", (key) => {
  const { container, host } = mountAccessory(key, {}, "writer");
  expect(container.querySelector("a")).toBeNull();
  expect(host.navigation.openPage).not.toHaveBeenCalled();
});

it("refreshes only the visible session and ignores stale lookups after navigation", async () => {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const initialListeners = new Set(workboardTestHost().listeners);
  const sessionKey = "agent:main:workboard-card";
  const card = createWorkboardCard({ status: "review", sessionKey });
  const revision = { epoch: "test", revision: 1 };
  const fixture = mountAccessory(sessionKey, { cards: [card], revision });
  const { container, context, mounted, dispose, request, listeners } = fixture;
  await vi.advanceTimersByTimeAsync(0);
  expect(container.textContent).toContain(card.title);
  fixture.emit("plugin.workboard.changed", { ...revision, revision: 2, cardsRevision: 1 });
  await vi.advanceTimersByTimeAsync(0);
  expect(request).toHaveBeenCalledOnce();
  request.mockResolvedValueOnce({
    cards: [{ ...card, title: "Renamed" }],
    revision: { ...revision, revision: 3 },
  });
  fixture.emit("plugin.workboard.changed", { ...revision, revision: 3, cardsRevision: 3 });
  await vi.advanceTimersByTimeAsync(0);
  expect(container.textContent).toContain("Renamed");
  expect(request).toHaveBeenLastCalledWith("workboard.cards.list", {
    sessionKey,
    sinceRevision: { ...revision, sessionKey },
  });
  const pending = createDeferred<unknown>();
  request.mockReturnValueOnce(pending.promise);
  mounted?.update?.({ ...context, props: { sessionKey: "agent:main:other" } });
  mounted?.update?.({ ...context, presented: false });
  pending.resolve({ cards: [card] });
  await vi.advanceTimersByTimeAsync(0);
  expect(container.querySelector("a")).toBeNull();
  const count = request.mock.calls.length;
  fixture.emit("plugin.workboard.changed", { ...revision, revision: 4 });
  await vi.advanceTimersByTimeAsync(0);
  expect(request).toHaveBeenCalledTimes(count);
  dispose();
  expect(container.childElementCount).toBe(0);
  expect(listeners).toEqual(initialListeners);
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
