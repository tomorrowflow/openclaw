import "../../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import { nothing, render } from "lit";
import { expect, it, onTestFinished, vi } from "vitest";
import { normalizeCardsPayload } from "../../lib/workboard/normalization.ts";
import { getWorkboardState } from "../../lib/workboard/runtime.ts";
import {
  createWorkboardCard,
  createWorkboardTestClient,
} from "../../lib/workboard/test/index-helpers.ts";
import { waitForFast } from "../../test/wait-for.ts";
import { openCardDetails, renderCardDetailsPanel } from "./view-card-details.ts";
import { createCardGrilling } from "./view-card-grilling.ts";

const text = (element: Element | null | undefined) =>
  element?.textContent?.replace(/\s+/g, " ").trim();

const LOG = "## Question 1\n\nShould empty input return `[]`?\n";
const LOG_TEXT = "## Question 1 Should empty input return `[]`?";

function grillingCard(overrides: Record<string, unknown> = {}) {
  const [card] = normalizeCardsPayload({
    cards: [
      {
        ...createWorkboardCard({ status: "review" }),
        stage: { kind: "grilling", since: 1, round: 1 },
        grill: { status: "open", rounds: 1, attachmentId: "log-1" },
        metadata: {
          attachments: [
            {
              id: "log-1",
              cardId: "card-1",
              fileName: "grilling.md",
              mimeType: "text/markdown",
              byteSize: LOG.length,
              createdAt: 1,
            },
          ],
        },
        ...overrides,
      },
    ],
  }).cards;
  return expectDefined(card, "card");
}

const SESSION_KEY = "agent:dev:subagent:workboard-default-card-1";

it("opens a waiting card on its Grilling tab, shows the log, and leads to the session chat", async () => {
  const card = grillingCard({ sessionKey: SESSION_KEY });
  const client = createWorkboardTestClient({
    "workboard.cards.attachments.get": { contentBase64: Buffer.from(LOG).toString("base64") },
  });
  const onOpenSession = vi.fn();
  const host = {};
  const state = getWorkboardState(host);
  state.loaded = true;
  state.cards = [card];
  openCardDetails(state, card);
  const container = document.createElement("div");
  document.body.append(container);
  onTestFinished(() => {
    render(nothing, container);
    container.remove();
  });
  const renderPanel = () =>
    render(
      renderCardDetailsPanel({
        host,
        client,
        connected: true,
        canWrite: true,
        agentsList: null,
        sessions: [],
        onOpenSession,
        onRequestUpdate: () => renderPanel(),
        detailGrilling: grilling,
      }),
      container,
    );
  const grilling = createCardGrilling(client, () => renderPanel());
  renderPanel();

  expect(
    container.querySelector("#workboard-detail-tab-grilling")?.getAttribute("aria-selected"),
  ).toBe("true");
  const panel = expectDefined(
    container.querySelector("#workboard-detail-panel-grilling"),
    "grilling panel",
  );
  await waitForFast(() =>
    expect(text(panel.querySelector(".workboard-grilling__log"))).toBe(LOG_TEXT),
  );
  expect(client.request).toHaveBeenCalledWith("workboard.cards.attachments.get", { id: "log-1" });
  expect(text(panel.querySelector(".workboard-grilling__note"))).toBe(
    "The grilling happens in the card's session chat: answer the agent's questions there. It ends when the agent replies with what is settled, or when you end it here.",
  );
  expect(panel.querySelector("textarea")).toBeNull();

  expectDefined(
    panel.querySelector<HTMLButtonElement>("[data-grilling-action=chat]"),
    "chat button",
  ).click();

  expect(onOpenSession).toHaveBeenCalledWith({ sessionKey: SESSION_KEY });
});

it("ends a waiting grilling, but not while the session is replying", async () => {
  const card = grillingCard({ sessionKey: SESSION_KEY });
  const ended = grillingCard({
    sessionKey: SESSION_KEY,
    status: "todo",
    stage: undefined,
    grill: { status: "closed", rounds: 1, attachmentId: "log-1" },
  });
  const client = createWorkboardTestClient({
    "workboard.cards.attachments.get": { contentBase64: Buffer.from(LOG).toString("base64") },
    "workboard.cards.grill.end": { card: ended },
  });
  const host = {};
  const state = getWorkboardState(host);
  state.loaded = true;
  state.cards = [card];
  state.detailCardId = card.id;
  state.detailTab = "grilling";
  const container = document.createElement("div");
  document.body.append(container);
  onTestFinished(() => {
    render(nothing, container);
    container.remove();
  });
  let sessions = [{ key: SESSION_KEY, kind: "direct", updatedAt: 1, hasActiveRun: true }];
  const renderPanel = () =>
    render(
      renderCardDetailsPanel({
        host,
        client,
        connected: true,
        canWrite: true,
        agentsList: null,
        sessions: sessions as never,
        onOpenSession: vi.fn(),
        onRequestUpdate: () => renderPanel(),
        detailGrilling: grilling,
      }),
      container,
    );
  const grilling = createCardGrilling(client, () => renderPanel());
  renderPanel();

  const panel = expectDefined(
    container.querySelector("#workboard-detail-panel-grilling"),
    "grilling panel",
  );
  const end = () =>
    expectDefined(
      panel.querySelector<HTMLButtonElement>("[data-grilling-action=end]"),
      "end button",
    );
  expect(end().disabled, "the session is replying").toBe(true);
  expect(end().title).toBe("The session is replying; end the grilling once the reply is in.");

  sessions = [{ key: SESSION_KEY, kind: "direct", updatedAt: 2, hasActiveRun: false }];
  renderPanel();
  expect(end().disabled).toBe(false);
  end().click();

  await waitForFast(() =>
    expect(client.request).toHaveBeenCalledWith("workboard.cards.grill.end", { id: card.id }),
  );
  await waitForFast(() => expect(panel.querySelector("[data-grilling-action]")).toBeNull());
});

it("shows a closed grilling's log without its actions", async () => {
  const card = grillingCard({
    status: "running",
    stage: { kind: "running" },
    grill: { status: "closed", rounds: 2, attachmentId: "log-1" },
  });
  const client = createWorkboardTestClient({
    "workboard.cards.attachments.get": { contentBase64: Buffer.from(LOG).toString("base64") },
  });
  const host = {};
  const state = getWorkboardState(host);
  state.loaded = true;
  state.cards = [card];
  state.detailCardId = card.id;
  state.detailTab = "grilling";
  const container = document.createElement("div");
  document.body.append(container);
  onTestFinished(() => {
    render(nothing, container);
    container.remove();
  });
  const renderPanel = () =>
    render(
      renderCardDetailsPanel({
        host,
        client,
        connected: true,
        canWrite: true,
        agentsList: null,
        sessions: [],
        onOpenSession: vi.fn(),
        detailGrilling: grilling,
      }),
      container,
    );
  const grilling = createCardGrilling(client, () => renderPanel());
  renderPanel();

  const panel = expectDefined(
    container.querySelector("#workboard-detail-panel-grilling"),
    "grilling panel",
  );
  await waitForFast(() =>
    expect(text(panel.querySelector(".workboard-grilling__log"))).toBe(LOG_TEXT),
  );
  expect(panel.querySelector("[data-grilling-action]")).toBeNull();
});

it.each([
  {
    name: "a log the card no longer lists",
    metadata: {},
    expected: "The grilling log is missing.",
  },
  {
    name: "a log the Gateway cannot read",
    metadata: undefined,
    expected: "The grilling log is missing or unreadable: attachment not found: log-1",
  },
])("says the grilling log is missing for $name", async ({ metadata, expected }) => {
  const card = grillingCard(metadata ? { metadata } : {});
  const client = createWorkboardTestClient(() => {
    throw new Error("attachment not found: log-1");
  });
  const host = {};
  const state = getWorkboardState(host);
  state.loaded = true;
  state.cards = [card];
  state.detailCardId = card.id;
  state.detailTab = "grilling";
  const container = document.createElement("div");
  document.body.append(container);
  onTestFinished(() => {
    render(nothing, container);
    container.remove();
  });
  const renderPanel = () =>
    render(
      renderCardDetailsPanel({
        host,
        client,
        connected: true,
        canWrite: true,
        agentsList: null,
        sessions: [],
        onOpenSession: vi.fn(),
        detailGrilling: grilling,
      }),
      container,
    );
  const grilling = createCardGrilling(client, () => renderPanel());
  renderPanel();

  const panel = expectDefined(
    container.querySelector("#workboard-detail-panel-grilling"),
    "grilling panel",
  );
  await waitForFast(() =>
    expect(text(panel.querySelector(".workboard-grilling__note"))).toBe(expected),
  );
});
