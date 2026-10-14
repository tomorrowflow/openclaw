import "../../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import { nothing, render, type LitElement } from "lit";
import { expect, it, onTestFinished, vi } from "vitest";
import { getWorkboardState } from "../../lib/workboard/runtime.ts";
import {
  createWorkboardCard,
  createWorkboardTestClient,
} from "../../lib/workboard/test/index-helpers.ts";
import type { WorkboardCard } from "../../lib/workboard/types.ts";
import { workboardTestHost } from "../../test/host.setup.ts";
import { waitForFast } from "../../test/wait-for.ts";
import { renderCardDetailsPanel } from "./view-card-details.ts";
import { renderColumn } from "./view-card.ts";

function renderDetails(card: WorkboardCard) {
  const host = {};
  const state = getWorkboardState(host);
  state.loaded = true;
  state.cards = [card];
  state.detailCardId = card.id;
  const container = document.createElement("div");
  document.body.append(container);
  onTestFinished(() => {
    render(nothing, container);
    container.remove();
  });
  workboardTestHost().connection.connected = true;
  render(
    renderCardDetailsPanel({
      host,
      client: createWorkboardTestClient({}),
      connected: true,
      canWrite: true,
      agentsList: null,
      sessions: [],
      onOpenSession: vi.fn(),
    }),
    container,
  );
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
  const owner = expectDefined(trigger.closest<LitElement>("workboard-inline-text"), "editor");
  const mountMarkdown = workboardTestHost().host.components.mountMarkdown;
  expect(mountMarkdown).toHaveBeenCalledWith(expect.any(HTMLElement), { markdown: card.notes });
  expect(mountMarkdown).toHaveBeenCalledWith(expect.any(HTMLElement), {
    markdown: "**Blocked** on review",
  });
  const link = document.createElement("a");
  link.href = "#spec";
  expectDefined(trigger.querySelector("[data-test-markdown]"), "notes markdown").append(link);
  link.click();
  await owner.updateComplete;
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
    const container = document.createElement("div");
    document.body.append(container);
    onTestFinished(() => {
      render(nothing, container);
      container.remove();
    });
    workboardTestHost().connection.connected = true;
    const props = {
      host,
      client: createWorkboardTestClient({}),
      connected: true,
      canWrite: true,
      agentsList: null,
      sessions: [],
      onOpenSession: vi.fn(),
    };
    render(renderColumn(props, "ready", [card], { surface }), container);
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
