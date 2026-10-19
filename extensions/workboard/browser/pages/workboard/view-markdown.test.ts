import "../../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import { render } from "@solidjs/web";
import { createComponent, flush } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { normalizeCardsPayload } from "../../lib/workboard/normalization.ts";
import { getWorkboardState } from "../../lib/workboard/runtime.ts";
import {
  createWorkboardCard,
  createWorkboardTestClient,
} from "../../lib/workboard/test/index-helpers.ts";
import type { WorkboardCard, WorkboardStatus } from "../../lib/workboard/types.ts";
import { workboardTestHost } from "../../test/host.setup.ts";
import { waitForFast } from "../../test/wait-for.ts";
import type { WorkboardCardSurface } from "./view-card.tsx";
import { WorkboardColumn } from "./view-column.tsx";
import { createWorkboardView } from "./view.test-support.ts";

function renderDetails(card: WorkboardCard) {
  const view = createWorkboardView({ client: createWorkboardTestClient({}), canWrite: true });
  view.state.cards = [card];
  view.state.detailCardId = card.id;
  view.renderView();
  return view.container;
}

function renderColumn(
  host: object,
  status: WorkboardStatus,
  cards: WorkboardCard[],
  surface: WorkboardCardSurface,
) {
  const container = document.createElement("div");
  document.body.append(container);
  workboardTestHost().connection.connected = true;
  const dispose = render(
    () =>
      createComponent(WorkboardColumn, {
        workboard: {
          host,
          client: createWorkboardTestClient({}),
          connected: true,
          canWrite: true,
          agentsList: null,
          sessions: [],
          onOpenSession: vi.fn(),
        },
        status,
        cards,
        options: { surface },
      }),
    container,
  );
  flush();
  onTestFinished(() => {
    dispose();
    container.remove();
  });
  return container;
}

it("renders notes and comments as host Markdown and follows note links without editing", async () => {
  const card = createWorkboardCard({
    notes: "See [spec](https://example.com)",
    metadata: { comments: [{ id: "comment-1", body: "**Blocked** on review", createdAt: 2 }] },
  });
  const container = renderDetails(card);
  const trigger = await waitForFast(() =>
    expectDefined(
      container.querySelector<HTMLElement>(".workboard-detail__text-trigger--notes"),
      "notes trigger",
    ),
  );
  const owner = expectDefined(trigger.closest<HTMLElement>("workboard-inline-text"), "editor");
  const mountMarkdown = workboardTestHost().host.components.mountMarkdown;
  expect(mountMarkdown).toHaveBeenCalledWith(expect.any(HTMLElement), { markdown: card.notes });
  expect(mountMarkdown).toHaveBeenCalledWith(expect.any(HTMLElement), {
    markdown: "**Blocked** on review",
  });
  const link = document.createElement("a");
  link.href = "#spec";
  expectDefined(trigger.querySelector("[data-test-markdown]"), "notes markdown").append(link);
  link.click();
  flush();
  expect(owner.querySelector("textarea")).toBeNull();

  trigger.click();
  const textarea = await waitForFast(() =>
    expectDefined(owner.querySelector("textarea"), "notes editor"),
  );
  expect(textarea.value).toBe(card.notes);
});

it.each(["page", "widget"] as const)(
  "previews notes on the %s card face without making them interactive",
  (surface) => {
    const card = createWorkboardCard({ status: "ready", notes: "**Ship** the [brief](#b)" });
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [card];
    const container = renderColumn(host, "ready", [card], surface);
    const preview = container.querySelector<HTMLElement>(".workboard-card__notes");
    if (surface === "widget") {
      expect(preview).toBeNull();
      return;
    }
    expect(preview?.hasAttribute("inert")).toBe(true);
    expect(preview?.getAttribute("aria-hidden")).toBe("true");
    expect(preview?.textContent).toContain(card.notes);
  },
);

it("shows the summary and the stage the Gateway derived on the card face and in the drawer", () => {
  const since = Date.now() - 3 * 3_600_000 - 60_000;
  const [card, malformed] = normalizeCardsPayload({
    cards: [
      {
        ...createWorkboardCard({
          status: "review",
          notes: "Long acceptance criteria",
          metadata: { automation: { summary: "Empty input crashes the **parser**." } },
        }),
        stage: { kind: "questions", since, escalatedAt: since + 1 },
      },
      // A stage the UI cannot render is dropped, not guessed.
      { ...createWorkboardCard({ id: "card-2" }), stage: { kind: "published", since } },
    ],
  }).cards;
  expect(malformed).not.toHaveProperty("stage");
  const listed = expectDefined(card, "card");
  const host = {};
  const state = getWorkboardState(host);
  state.loaded = true;
  state.cards = [listed];
  const container = renderColumn(host, "review", [listed], "page");

  const preview = container.querySelector(".workboard-card__notes")?.textContent;
  expect(preview).toContain("Empty input crashes the **parser**.");
  expect(preview).not.toContain("Long acceptance criteria");
  expect(
    container.querySelector(".workboard-card__stage")?.textContent?.replace(/\s+/g, " ").trim(),
  ).toBe("Questions waiting for you 3h");

  const drawer = renderDetails(listed);
  expect(drawer.querySelector(".workboard-detail__summary .workboard-card__stage")).not.toBeNull();
  expect(workboardTestHost().host.components.mountMarkdown).toHaveBeenCalledWith(
    expect.any(HTMLElement),
    { markdown: "Empty input crashes the **parser**." },
  );
});
