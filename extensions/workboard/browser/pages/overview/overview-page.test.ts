import "../../test/dom.setup.ts";
import type { WorkboardOverviewResult } from "@openclaw/workboard-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkboardCapability } from "../../lib/workboard/capability.ts";
import { WORKBOARD_CHANGED_EVENT } from "../../lib/workboard/types.ts";
import { workboardTestHost } from "../../test/host.setup.ts";
import { createViewContext } from "../../test/host.ts";
import { waitForFast } from "../../test/wait-for.ts";
import { createOverviewPage } from "./overview-page.ts";

const NOW = Date.now();
const PR = "https://github.com/acme/app/pull/7";

function overview(overrides: Partial<WorkboardOverviewResult> = {}): WorkboardOverviewResult {
  return {
    boardId: "all",
    generatedAt: NOW,
    needsYou: [
      {
        cardId: "card-1",
        boardId: "app",
        title: "Parser crash",
        summary: "Empty input crashes the parser.",
        stage: { kind: "awaiting_review", since: NOW - 60_000 },
        reason: "decide",
        waitingSince: NOW - 60_000,
      },
    ],
    inFlight: [
      {
        cardId: "card-2",
        boardId: "app",
        title: "Retry uploads",
        stage: { kind: "running", since: NOW, nodeId: "mac-factory" },
        nodeId: "mac-factory",
        round: 1,
        contextTokens: 90_000,
      },
    ],
    shipped: [
      {
        cardId: "card-3",
        boardId: "app",
        title: "Docs fix",
        stage: { kind: "published", since: NOW, pullRequestUrl: PR, reworkRound: 0 },
        shippedAt: NOW,
        pullRequestUrl: PR,
        rounds: 1,
        decidedBy: "agent",
        sampled: false,
      },
    ],
    insights: [],
    open: { review: 1, running: 1 },
    week: { weekStart: NOW, accepted: 2, autonomous: 1 },
    ...overrides,
  };
}

const mounted: Array<() => void> = [];
afterEach(() => {
  for (const dispose of mounted.splice(0)) {
    dispose();
  }
  document.body.replaceChildren();
});

function mountOverview(load: () => Promise<WorkboardOverviewResult>) {
  const fixture = workboardTestHost();
  fixture.connection.connected = true;
  const request = vi.fn(async (method: string) => {
    if (method === "workboard.overview") {
      return await load();
    }
    throw new Error(`unexpected ${method}`);
  });
  fixture.host.request = request as typeof fixture.host.request;
  const workboard = createWorkboardCapability();
  const container = document.createElement("div");
  document.body.append(container);
  const view = createOverviewPage(workboard)(container, createViewContext(fixture.host, {}));
  mounted.push(() => view?.dispose?.());
  const reads = () => request.mock.calls.filter(([method]) => method === "workboard.overview");
  return { fixture, workboard, container, reads };
}

function bandText(container: HTMLElement, id: string) {
  return container.querySelector(`[aria-labelledby="workboard-overview-${id}"]`)?.textContent;
}

describe("Factory overview page", () => {
  it("renders each band with its rows, status line, and an empty state", async () => {
    const { container, fixture } = mountOverview(async () => overview());

    await waitForFast(() =>
      expect(container.querySelector(".workboard-overview__row")).not.toBeNull(),
    );

    expect(bandText(container, "needs-you")).toContain("Your decision");
    expect(bandText(container, "needs-you")).toContain("Ready for your review");
    expect(fixture.host.components.mountMarkdown).toHaveBeenCalledWith(expect.any(HTMLElement), {
      markdown: "Empty input crashes the parser.",
    });
    expect(bandText(container, "in-flight")).toContain("Running on mac-factory");
    expect(bandText(container, "in-flight")).toContain("90K context");
    expect(bandText(container, "in-flight")).not.toContain("Node mac-factory");
    expect(bandText(container, "shipped")).toContain("Accepted by an agent");
    expect(container.querySelector<HTMLAnchorElement>(`a[href="${PR}"]`)).not.toBeNull();
    expect(bandText(container, "insights")).toContain(
      "No gardener or architecture findings wait in the backlog.",
    );
    expect(container.querySelector(".workboard-overview__counters")?.textContent).toContain(
      "1 of 2 autonomous this week",
    );
  });

  it("reloads on a Workboard change and folds a burst during a read into one more read", async () => {
    let release: () => void = () => undefined;
    let first = true;
    const { fixture, reads, container } = mountOverview(async () => {
      if (first) {
        first = false;
        return overview();
      }
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return overview({ needsYou: [] });
    });
    await waitForFast(() =>
      expect(container.querySelector(".workboard-overview__row")).not.toBeNull(),
    );

    fixture.emit(WORKBOARD_CHANGED_EVENT, { cardsRevision: 2 });
    fixture.emit(WORKBOARD_CHANGED_EVENT, { cardsRevision: 3 });
    fixture.emit(WORKBOARD_CHANGED_EVENT, { cardsRevision: 4 });
    expect(reads()).toHaveLength(2);
    release();

    await waitForFast(() => expect(reads()).toHaveLength(3));
    release();
    await waitForFast(() =>
      expect(bandText(container, "needs-you")).toContain("Nothing waits on you."),
    );
    expect(reads()).toHaveLength(3);
  });

  it("asks the board page to reveal the card and opens its board", async () => {
    const { container, fixture, workboard } = mountOverview(async () => overview());
    await waitForFast(() =>
      expect(container.querySelector(".workboard-overview__title")).not.toBeNull(),
    );

    container.querySelector<HTMLAnchorElement>(".workboard-overview__title")?.click();

    expect(workboard.state.revealCardId).toBe("card-1");
    expect(fixture.host.navigation.openPage).toHaveBeenCalledWith({
      id: "workboard",
      path: ["app"],
    });
  });

  it("keeps the last overview on screen when a reload fails", async () => {
    let fail = false;
    const { fixture, container, reads } = mountOverview(async () => {
      if (fail) {
        throw new Error("gateway restarting");
      }
      return overview();
    });
    await waitForFast(() =>
      expect(container.querySelector(".workboard-overview__row")).not.toBeNull(),
    );
    fail = true;

    fixture.emit(WORKBOARD_CHANGED_EVENT, { cardsRevision: 2 });

    await waitForFast(() => expect(container.textContent).toContain("gateway restarting"));
    expect(reads()).toHaveLength(2);
    expect(bandText(container, "needs-you")).toContain("Parser crash");
  });
});
