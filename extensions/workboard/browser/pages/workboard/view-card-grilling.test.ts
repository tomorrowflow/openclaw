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

it("opens a waiting card on its Grilling tab, shows the log, and sends the answer", async () => {
  const card = grillingCard();
  const answered = grillingCard({ status: "todo", stage: undefined });
  const client = createWorkboardTestClient({
    "workboard.cards.attachments.get": { contentBase64: Buffer.from(LOG).toString("base64") },
    "workboard.cards.grill.answer": { card: answered },
  });
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
        onOpenSession: vi.fn(),
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

  const answer = expectDefined(panel.querySelector("textarea"), "answer box");
  const send = expectDefined(
    panel.querySelector<HTMLButtonElement>("[data-grilling-action=send]"),
    "send button",
  );
  expect(send.disabled).toBe(true);
  answer.value = "Yes, return [].";
  answer.dispatchEvent(new InputEvent("input"));
  expect(send.disabled).toBe(false);
  send.click();

  await waitForFast(() =>
    expect(client.request).toHaveBeenCalledWith("workboard.cards.grill.answer", {
      id: card.id,
      answer: "Yes, return [].",
    }),
  );
  await waitForFast(() =>
    expect(text(panel.querySelector(".workboard-grilling__note"))).toBe(
      "The agent is working on your last answer.",
    ),
  );
  expect(panel.querySelector("textarea")?.disabled).toBe(true);
  expect(panel.querySelector("textarea")?.value).toBe("");
  expect(
    panel.querySelector<HTMLButtonElement>("[data-grilling-action=end]")?.disabled,
    "nothing to end while the agent works on the answer",
  ).toBe(true);
});

it("ends a waiting grilling with the answer box's text as its closing note", async () => {
  const card = grillingCard();
  const ended = grillingCard({
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
  expect(end.disabled, "End needs no text").toBe(false);
  const note = expectDefined(panel.querySelector("textarea"), "answer box");
  note.value = "  Ship the parser only.  ";
  note.dispatchEvent(new InputEvent("input"));
  end.click();

  await waitForFast(() =>
    expect(client.request).toHaveBeenCalledWith("workboard.cards.grill.end", {
      id: card.id,
      note: "Ship the parser only.",
    }),
  );
  await waitForFast(() => expect(panel.querySelector("textarea")).toBeNull());
  expect(client.request).not.toHaveBeenCalledWith(
    "workboard.cards.grill.answer",
    expect.anything(),
  );
});

it("shows a closed grilling's log without an answer box", async () => {
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
  expect(panel.querySelector("textarea")).toBeNull();
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
