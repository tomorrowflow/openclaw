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

const LOG = "## Handoff 1\n\nShould empty input return `[]`?\n";
const LOG_TEXT = "## Handoff 1 Should empty input return `[]`?";

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
const GRILL_SESSION_KEY = "agent:dev:grill-card-1-1";
const OPEN_GRILL = {
  status: "open",
  rounds: 1,
  attachmentId: "log-1",
  sessionKey: GRILL_SESSION_KEY,
};

it("opens a waiting card on its Grilling tab, shows the log, and leads to the grill session", async () => {
  const card = grillingCard({ sessionKey: SESSION_KEY, grill: OPEN_GRILL });
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
    "The grilling runs in its own session, Grill Build board: answer the agent's questions there. It ends when the agent hands the result back, or when you end it here, which takes the agent's last reply as the result.",
  );
  expect(panel.querySelector("textarea")).toBeNull();
  expect(panel.querySelector("[data-grilling-action=chat]")).toBeNull();

  expectDefined(
    panel.querySelector<HTMLButtonElement>("[data-grilling-action=session]"),
    "grill session button",
  ).click();

  expect(onOpenSession).toHaveBeenCalledWith({ sessionKey: GRILL_SESSION_KEY });
});

it("says the grill session is starting until Workboard recorded it", async () => {
  const card = grillingCard({ sessionKey: SESSION_KEY });
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
  const grilling = createCardGrilling(client, () => undefined);
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

  const panel = expectDefined(
    container.querySelector("#workboard-detail-panel-grilling"),
    "grilling panel",
  );
  expect(text([...panel.querySelectorAll(".workboard-grilling__note")].at(-1))).toBe(
    "The grill session is starting…",
  );
  expect(panel.querySelector("[data-grilling-action=session]")).toBeNull();
  expect(panel.querySelector("[data-grilling-action=end]")).not.toBeNull();
});

it("ends a waiting grilling from the Grilling tab", async () => {
  const card = grillingCard({ sessionKey: SESSION_KEY, grill: OPEN_GRILL });
  const ended = grillingCard({
    sessionKey: SESSION_KEY,
    status: "todo",
    stage: undefined,
    grill: { ...OPEN_GRILL, status: "closed" },
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
  const end = expectDefined(
    panel.querySelector<HTMLButtonElement>("[data-grilling-action=end]"),
    "end button",
  );
  expect(end.title).toBe(
    "End the grilling; the agent's last reply in the grill session becomes the result, and the ticket continues with it.",
  );
  end.click();

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
