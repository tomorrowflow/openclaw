import "../../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import { flush } from "solid-js";
import { expect, it, vi } from "vitest";
import {
  createGatewaySession,
  createWorkboardCard,
  createWorkboardTestClient,
} from "../../lib/workboard/test/index-helpers.ts";
import type { WorkboardCard } from "../../lib/workboard/types.ts";
import { waitForFast } from "../../test/wait-for.ts";
import type { WorkboardProps } from "./view-helpers.tsx";
import { buttonByLabel, createWorkboardView, openCardMenu } from "./view.test-support.ts";

const provisional = "subagent:workboard-default-card-1";
const canonical = "agent:writer:existing";

function renderDetails(card: WorkboardCard, overrides: Partial<WorkboardProps> = {}) {
  const props = { canWrite: true, onOpenSession: vi.fn(), ...overrides };
  const view = createWorkboardView(props);
  const { state } = view;
  Object.assign(state, { cards: [card], detailCardId: card.id });
  view.renderView();
  const container = expectDefined(view.container.querySelector(".workboard-detail"), "detail");
  const button = (selector: string) =>
    expectDefined(container.querySelector<HTMLButtonElement>(selector), selector);
  return { state, props, container, button };
}

it.each([
  [canonical, "unknown", true],
  [canonical, "unavailable", true],
  [provisional, "unknown", false],
  [provisional, "ambiguous", false],
  ["global", "unknown", false],
  ["unknown", "unknown", false],
] as const)("keeps Edit recovery without replacement Start for %s (%s)", (key, status, canOpen) => {
  const card = createWorkboardCard({ sessionKey: key });
  const { container, state, props, button } = renderDetails(card, {
    sessionResolution: { key, status },
  });
  const open = buttonByLabel(container, "Open session");
  if (canOpen) {
    expectDefined(open, "canonical session action").click();
    expect(props.onOpenSession).toHaveBeenCalledWith({ sessionKey: key });
  } else {
    expect(open).toBeNull();
  }
  button('button[aria-label="Edit card"]').click();
  expect(state).toMatchObject({ draftOpen: true, draftSessionKey: key });
  expect(container.querySelectorAll(".workboard-card__start")).toHaveLength(0);
});

it.each([
  [provisional, `agent:writer:${provisional}`, undefined],
  [canonical, canonical, "writer"],
] as const)("stops %s's resolved owner after reassignment", async (key, sessionKey, agentId) => {
  const owner = { sessionKey, ...(agentId ? { agentId } : {}) };
  const session = createGatewaySession({ key: sessionKey, ...(agentId ? { agentId } : {}) });
  const card = createWorkboardCard({
    agentId: "main",
    sessionKey: key,
    status: "running",
    runId: "run",
  });
  const blocked = { ...card, status: "blocked", updatedAt: 2 };
  let aborts = 0;
  const client = createWorkboardTestClient((method) => {
    if (method === "chat.abort") {
      aborts += 1;
      return { aborted: !agentId || aborts > 1 };
    }
    if (method === "workboard.cards.update") {
      return { card: blocked };
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const { button, state } = renderDetails(card, {
    client,
    sessionResolution: { key, status: "resolved", session },
  });

  button('button[aria-label="Stop session"]').click();
  await waitForFast(() => expect(state.cards[0]?.status).toBe("blocked"));

  expect(client.request).toHaveBeenNthCalledWith(1, "chat.abort", { ...owner, runId: "run" });
  if (agentId) {
    expect(client.request).toHaveBeenNthCalledWith(2, "chat.abort", owner);
  }
  expect(state.error).toBeNull();
});

it.each(["start", "stop"] as const)("rejects stale %s after a link change", async (action) => {
  const session = createGatewaySession({ key: "agent:writer:original" });
  const card = createWorkboardCard(
    action === "stop" ? { sessionKey: session.key, status: "running" } : {},
  );
  const client = createWorkboardTestClient(() => {
    throw new Error("A retained action cannot operate on the replacement card");
  });
  const { button, state } = renderDetails(card, { client, sessions: [session] });
  const retained = button(
    action === "start" ? ".workboard-card__start--manual" : 'button[aria-label="Stop session"]',
  );
  const successor = {
    ...card,
    updatedAt: card.updatedAt + 1,
    sessionKey: "agent:writer:replacement",
  };
  state.cards = [successor];
  retained.click();
  await waitForFast(() => expect(state.error).toBeTruthy());

  expect(client.request).not.toHaveBeenCalled();
  expect(state.cards).toEqual([successor]);
  expect(state.busyCardIds.size).toBe(0);
});

it("updates and clears a card session target when only its resolution changes", () => {
  const card = createWorkboardCard({ sessionKey: provisional });
  const onOpenSession = vi.fn();
  const view = createWorkboardView({ canWrite: true, onOpenSession });
  view.state.cards = [card];
  const targets = [
    { sessionKey: "agent:writer:first", agentId: "writer" },
    { sessionKey: "agent:writer:first", agentId: "reviewer" },
    { sessionKey: "agent:reviewer:replacement", agentId: "reviewer" },
  ];
  for (const target of targets) {
    view.renderView({
      sessionResolution: {
        key: provisional,
        status: "resolved",
        session: createGatewaySession({ key: target.sessionKey, agentId: target.agentId }),
      },
    });
    const row = expectDefined(view.container.querySelector(".workboard-card"), "card row");
    const menu = openCardMenu(row);
    expectDefined(buttonByLabel(menu, "Open session"), "resolved session action").click();
    expect(onOpenSession).toHaveBeenLastCalledWith(target);
  }
  view.renderView({ sessionResolution: { key: provisional, status: "ambiguous" } });
  const row = expectDefined(view.container.querySelector(".workboard-card"), "card row");
  expect(buttonByLabel(openCardMenu(row), "Open session")).toBeNull();
  expect(view.state.cards[0]).toBe(card);
});

it("stays on the board after an autonomous start and opens the session of an interactive one", async () => {
  const card = createWorkboardCard();
  const client = createWorkboardTestClient((method) => {
    if (method === "workboard.cards.start") {
      return { card: { ...card, status: "running", sessionKey: "agent:main:run", updatedAt: 2 } };
    }
    if (method === "sessions.create") {
      return { key: "agent:main:manual" };
    }
    if (method === "workboard.cards.update") {
      return { card: { ...card, sessionKey: "agent:main:manual", updatedAt: 2 } };
    }
    throw new Error(`Unexpected request: ${method}`);
  });

  const autonomous = renderDetails(card, { client });
  expectDefined(
    autonomous.container.querySelector<HTMLButtonElement>(
      ".workboard-card__start--autonomous.workboard-card__start--default",
    ),
    "autonomous start",
  ).click();
  await waitForFast(() => expect(autonomous.state.cards[0]?.status).toBe("running"));
  expect(autonomous.props.onOpenSession).not.toHaveBeenCalled();

  const manual = renderDetails(card, { client });
  expectDefined(
    manual.container.querySelector<HTMLButtonElement>(".workboard-card__start--manual"),
    "interactive start",
  ).click();
  await waitForFast(() =>
    expect(manual.props.onOpenSession).toHaveBeenCalledWith({ sessionKey: "agent:main:manual" }),
  );
});

it("shows a queued node ticket's Start as queued and disabled", async () => {
  const card = createWorkboardCard({
    metadata: { automation: { target: NODE_TICKET_TARGET } },
  });
  const queued = {
    ...card,
    updatedAt: 2,
    startRequest: { requestedAt: 2, source: "operator" },
  };
  const client = createWorkboardTestClient({
    "workboard.cards.start": { queued: true, card: queued },
  });
  const { container, state, props } = renderDetails(card, { client });
  const start = () =>
    expectDefined(
      container.querySelector<HTMLButtonElement>(
        ".workboard-card__start--autonomous.workboard-card__start--default",
      ),
      "start action",
    );

  start().click();
  await waitForFast(() => expect(state.cards[0]?.updatedAt).toBe(2));
  props.onRequestUpdate?.();
  flush();

  expect(state.error).toBeNull();
  expect(props.onOpenSession).not.toHaveBeenCalled();
  expect(state.cards[0]?.startRequest).toEqual({ requestedAt: 2, source: "operator" });
  expect(start().textContent?.trim()).toBe("Queued");
  // A node ticket starts only through its own Start; engine starts would bypass the node.
  const controls = [...container.querySelectorAll<HTMLButtonElement>(".workboard-card__start")];
  expect(controls).toEqual([start()]);
  expect(start().disabled).toBe(true);
});

const NODE_TICKET_TARGET = {
  kind: "node-claude",
  nodeId: "mac-factory",
  repoPath: "/Users/factory/repos/app",
  worktreesRoot: "/Users/factory/worktrees",
  hostRepoPath: "/home/openclaw/repos/app",
} as const;
