import "./test/dom.setup.ts";
import { expect, it, vi } from "vitest";
import { createWorkboardCapability } from "./lib/workboard/capability.ts";
import { createWorkboardCard } from "./lib/workboard/test/index-helpers.ts";
import { createWorkboardPage } from "./pages/workboard/workboard-page.ts";
import { createWorkboardSessionAccessory } from "./session-accessory.ts";
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
  workboard.state.cards = [card];
  const container = document.createElement("div");
  const destination = document.createElement("div");
  document.body.append(container, destination);
  let disposeDestination = () => {};
  vi.mocked(host.navigation.openPage).mockImplementation(({ path }) => {
    disposeDestination();
    const mounted = createWorkboardPage(workboard, vi.fn())(
      destination,
      createViewContext(host, { boardId: path?.[0] ?? "__all__" }),
    );
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
    expect(host.agents.scopeId).toBeNull();
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
    const workboard = createWorkboardCapability();
    workboard.state.cards = [createWorkboardCard({ sessionKey, agentId: "main" })];
    const container = document.createElement("div");
    const mounted = createWorkboardSessionAccessory(workboard)(
      container,
      createViewContext(fixture.host, { sessionKey, agentId: "writer" }),
    );
    try {
      expect(container.querySelector("a")).toBeNull();
      expect(fixture.host.navigation.openPage).not.toHaveBeenCalled();
    } finally {
      mounted?.dispose?.();
      workboard.dispose();
    }
  },
);

it("renders shared card updates and retires navigation while hidden or disposed", async () => {
  const fixture = workboardTestHost();
  fixture.connection.connected = true;
  const sessionKey = "agent:main:workboard-card";
  const card = createWorkboardCard({
    title: "Ship dashboard stitch",
    status: "review",
    sessionKey,
    metadata: { automation: { boardId: "platform" } },
  });
  const workboard = createWorkboardCapability();
  workboard.state.cards = [card];
  const container = document.createElement("div");
  const context = createViewContext(fixture.host, { sessionKey });
  const mounted = createWorkboardSessionAccessory(workboard)(container, context);
  try {
    await vi.waitFor(() => expect(container.textContent).toContain(card.title));
    const link = container.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("/workboard/platform");
    expect(link.textContent).toContain("Review");
    link.click();
    expect(fixture.host.navigation.openPage).toHaveBeenCalledWith({
      id: "workboard",
      path: ["platform"],
    });
    mounted?.update?.({ ...context, presented: false, props: { sessionKey: "agent:main:next" } });
    expect(container.querySelector("a")).toBeNull();
    link.click();
    expect(fixture.host.navigation.openPage).toHaveBeenCalledOnce();
    workboard.state.cards = [
      createWorkboardCard({ title: "Next card", sessionKey: "agent:main:next" }),
    ];
    workboard.notify();
    expect(container.querySelector("a")).toBeNull();
    mounted?.update?.({ ...context, props: { sessionKey: "agent:main:next" } });
    expect(container.textContent).toContain("Next card");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/workboard/default");
    expect(container.textContent).not.toContain(card.title);
    expect(fixture.host.request).not.toHaveBeenCalled();
  } finally {
    mounted?.dispose?.();
  }
  workboard.notify();
  expect(container.childElementCount).toBe(0);
  expect(fixture.listeners.size).toBe(0);
  workboard.dispose();
});

it("offers a node ticket's session its Screens panel, and no other session", async () => {
  const { host, connection } = workboardTestHost();
  connection.connected = true;
  const workboard = createWorkboardCapability();
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
  workboard.state.cards = [nodeTicket, plain];
  const container = document.createElement("div");
  const mount = (sessionKey: string) =>
    createWorkboardSessionAccessory(workboard)(container, createViewContext(host, { sessionKey }));

  const plainChip = mount("agent:dev:workboard:plain");
  expect(container.querySelector(".workboard-session-chip")).not.toBeNull();
  expect(container.querySelector(".workboard-session-screens")).toBeNull();
  plainChip?.dispose?.();

  const nodeChip = mount("agent:dev:workboard:node");
  try {
    container.querySelector<HTMLButtonElement>(".workboard-session-screens")!.click();
    expect(host.ui.openPanel).toHaveBeenCalledExactlyOnceWith("screens", {
      sessionKey: "agent:dev:workboard:node",
    });
  } finally {
    nodeChip?.dispose?.();
    workboard.dispose();
  }
});

it("says a grilling card chats with its session and opens it on the board", async () => {
  const fixture = workboardTestHost();
  fixture.connection.connected = true;
  const sessionKey = "agent:dev:subagent:workboard-platform-card";
  const card = createWorkboardCard({
    title: "Spec the parser",
    status: "review",
    sessionKey,
    stage: { kind: "grilling", since: 1, round: 2 },
    metadata: { automation: { boardId: "platform" } },
  });
  const workboard = createWorkboardCapability();
  workboard.state.cards = [card];
  const container = document.createElement("div");
  const mounted = createWorkboardSessionAccessory(workboard)(
    container,
    createViewContext(fixture.host, { sessionKey }),
  );
  try {
    await vi.waitFor(() => expect(container.textContent).toContain(card.title));
    const link = container.querySelector("a")!;
    expect(link.querySelector(".workboard-session-chip__status")?.textContent).toBe(
      "Grilling — chat with the session",
    );
    link.click();
    expect(workboard.state.revealCardId).toBe(card.id);
    expect(fixture.host.navigation.openPage).toHaveBeenCalledWith({
      id: "workboard",
      path: ["platform"],
    });
  } finally {
    mounted?.dispose?.();
    workboard.dispose();
  }
});
