import "./test/dom.setup.ts";
import type { ControlUiSurfaceProps } from "openclaw/plugin-sdk/control-ui";
import { expect, it, vi } from "vitest";
import { createWorkboardGrillingComposer } from "./grilling-composer.ts";
import { createWorkboardCapability } from "./lib/workboard/capability.ts";
import { createWorkboardCard } from "./lib/workboard/test/index-helpers.ts";
import type { WorkboardCard } from "./lib/workboard/types.ts";
import { workboardTestHost } from "./test/host.setup.ts";

const GRILLING_KEY = "agent:dev:subagent:workboard-platform-card-1";
const OTHER_KEY = "agent:dev:subagent:workboard-platform-card-2";

function mountComposer(cards: WorkboardCard[], sessionKey: string) {
  const fixture = workboardTestHost();
  fixture.connection.connected = true;
  fixture.connection.canWrite = true;
  const request = vi.fn(async () => ({ runId: "run-1", status: "started" }));
  fixture.host.request = request as typeof fixture.host.request;
  const workboard = createWorkboardCapability();
  workboard.state.cards = cards;
  const container = document.createElement("div");
  document.body.append(container);
  const defaults: HTMLElement[] = [];
  const mountDefault = vi.fn((target: HTMLElement) => {
    target.innerHTML = '<textarea class="host-composer"></textarea>';
    defaults.push(target);
    return () => {
      target.replaceChildren();
    };
  });
  const props: ControlUiSurfaceProps["composer"] = {
    sessionKey,
    agentId: "dev",
    draft: "",
    canSend: false,
    sending: false,
    disabledReason: null,
    setDraft: vi.fn((text: string) => {
      props.draft = text;
    }),
    send: vi.fn(async () => true),
  };
  const mounted = createWorkboardGrillingComposer(workboard)(container, {
    host: fixture.host,
    signal: fixture.host.signal,
    props,
    presented: true,
    mountDefault,
  });
  const grillingBox = () =>
    container.querySelector<HTMLTextAreaElement>(".workboard-grill-composer textarea");
  const hostBox = () => container.querySelector(".host-composer");
  return {
    fixture,
    request,
    workboard,
    container,
    props,
    mountDefault,
    grillingBox,
    hostBox,
    dispose() {
      mounted?.dispose?.();
      workboard.dispose();
      container.remove();
    },
  };
}

const grillingCard = () =>
  createWorkboardCard({
    sessionKey: GRILLING_KEY,
    status: "review",
    stage: { kind: "grilling", since: 1, round: 1 },
  });

it("chats with a grilling card's session through chat.send: Enter sends, Shift+Enter does not", async () => {
  const composer = mountComposer([grillingCard()], GRILLING_KEY);
  try {
    const box = composer.grillingBox();
    expect(box, "grilling composer").not.toBeNull();
    expect(composer.hostBox()).toBeNull();
    expect(composer.mountDefault).not.toHaveBeenCalled();
    expect(composer.container.textContent).toContain(
      "Grilling: the agent asks one question at a time.",
    );

    box!.value = "Yes, return [].";
    box!.dispatchEvent(new InputEvent("input"));
    expect(composer.props.setDraft).toHaveBeenCalledWith("Yes, return [].");

    box!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true }));
    expect(composer.request).not.toHaveBeenCalled();
    box!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
    await vi.waitFor(() => expect(composer.props.setDraft).toHaveBeenLastCalledWith(""));
    expect(composer.request).toHaveBeenCalledOnce();
    expect(composer.request, "the card key is agent-scoped").toHaveBeenCalledWith("chat.send", {
      sessionKey: GRILLING_KEY,
      message: "Yes, return [].",
      idempotencyKey: expect.any(String),
    });
    expect(composer.props.send, "the host's send refuses subagent sessions").not.toHaveBeenCalled();
  } finally {
    composer.dispose();
  }
});

it("holds the next message while the agent replies to the last one", async () => {
  const composer = mountComposer([grillingCard()], GRILLING_KEY);
  try {
    const setReplying = (hasActiveRun: boolean) => {
      Object.assign(composer.fixture.host.sessions, {
        rows: [{ key: GRILLING_KEY, kind: "direct", updatedAt: 1, hasActiveRun }],
      });
      composer.fixture.notify();
    };
    const sendButton = () =>
      composer.container.querySelector<HTMLButtonElement>(".workboard-grill-composer button");
    const box = composer.grillingBox()!;
    box.value = "And for whitespace-only input?";
    box.dispatchEvent(new InputEvent("input"));
    setReplying(true);

    expect(sendButton()?.disabled).toBe(true);
    expect(composer.container.querySelector('[role="status"]')?.textContent?.trim()).toBe(
      "The agent is replying…",
    );
    expect(composer.grillingBox()?.disabled, "typing stays allowed").toBe(false);
    composer
      .grillingBox()!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
    expect(composer.request).not.toHaveBeenCalled();

    setReplying(false);
    expect(sendButton()?.disabled).toBe(false);
    expect(composer.container.querySelector('[role="status"]')).toBeNull();
    sendButton()!.click();
    await vi.waitFor(() => expect(composer.request).toHaveBeenCalledOnce());
  } finally {
    composer.dispose();
  }
});

it("mounts the host's composer for any other session and when the grilling ends", async () => {
  const other = createWorkboardCard({ id: "card-2", sessionKey: OTHER_KEY, status: "running" });
  const elsewhere = mountComposer([grillingCard(), other], OTHER_KEY);
  try {
    expect(elsewhere.grillingBox()).toBeNull();
    expect(elsewhere.hostBox(), "host composer").not.toBeNull();
  } finally {
    elsewhere.dispose();
  }

  const composer = mountComposer([grillingCard()], GRILLING_KEY);
  try {
    expect(composer.grillingBox()).not.toBeNull();
    composer.workboard.state.cards = [{ ...grillingCard(), status: "todo", stage: undefined }];
    composer.workboard.notify();
    await vi.waitFor(() => expect(composer.hostBox()).not.toBeNull());
    expect(composer.grillingBox()).toBeNull();
  } finally {
    composer.dispose();
  }
});

it("falls back to the host's composer when it cannot read the board", () => {
  const fixture = workboardTestHost();
  vi.spyOn(fixture.host.sessions, "normalizeKey").mockImplementation(() => {
    throw new Error("Workboard is no longer active.");
  });
  const composer = mountComposer([grillingCard()], GRILLING_KEY);
  try {
    expect(composer.grillingBox()).toBeNull();
    expect(composer.hostBox(), "host composer").not.toBeNull();
  } finally {
    composer.dispose();
  }
});
