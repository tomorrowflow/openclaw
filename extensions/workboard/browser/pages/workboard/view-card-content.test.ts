import "../../test/dom.setup.ts";
import { render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import { normalizeCardsPayload } from "../../lib/workboard/normalization.ts";
import { createWorkboardCard } from "../../lib/workboard/test/index-helpers.ts";
import { renderCardMeta, renderCardPullRequest, renderCardStage } from "./view-card-content.ts";

afterEach(() => vi.unstubAllGlobals());

it("leaves settled labels untouched until their available width changes", () => {
  let resize: ResizeObserverCallback = () => {};
  let frame: FrameRequestCallback = () => {};
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frame = callback;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  const container = document.createElement("div");
  document.body.append(container);
  const root = render(
    renderCardMeta(createWorkboardCard({ labels: ["alpha", "beta"] }), false),
    container,
  );
  const labels = container.querySelector<HTMLElement>(".workboard-card__labels")!;
  const chips = [...labels.querySelectorAll<HTMLElement>(".workboard-card__label")];
  const overflow = labels.querySelector<HTMLElement>(".workboard-card__label-overflow")!;
  let width = 100;
  Object.defineProperty(labels, "clientWidth", { get: () => width });
  for (const chip of chips) {
    vi.spyOn(chip, "getBoundingClientRect").mockReturnValue({ width: 60 } as DOMRect);
  }
  vi.spyOn(overflow, "getBoundingClientRect").mockReturnValue({ width: 20 } as DOMRect);
  const mutations = new MutationObserver(() => {});
  mutations.observe(labels, { attributes: true, childList: true, subtree: true });
  const notifyResize = () =>
    resize(
      [
        {
          target: labels,
          contentRect: new DOMRect(0, 0, width, 24),
          borderBoxSize: [],
          contentBoxSize: [],
          devicePixelContentBoxSize: [],
        },
      ],
      {} as ResizeObserver,
    );
  try {
    frame(0);
    expect(chips.map((chip) => chip.hidden)).toEqual([false, true]);
    expect(overflow.textContent).toBe("+1");
    mutations.takeRecords();
    notifyResize();
    expect(mutations.takeRecords()).toEqual([]);
    width = 200;
    notifyResize();
    frame(0);
    expect(chips.map((chip) => chip.hidden)).toEqual([false, false]);
    expect(overflow.hidden).toBe(true);
    width = 100;
    notifyResize();
    frame(0);
    expect(chips.map((chip) => chip.hidden)).toEqual([false, true]);
    expect(overflow.title).toBe("beta");
  } finally {
    mutations.disconnect();
    root.setConnected(false);
  }
});

it("shows a queued card's chip in the tile meta, which is visible without hover", () => {
  const target = {
    kind: "node-claude",
    nodeId: "mac-factory",
    repoPath: "/Users/factory/repos/app",
    worktreesRoot: "/Users/factory/worktrees",
    hostRepoPath: "/home/openclaw/repos/app",
  } as const;
  const container = document.createElement("div");
  const meta = (startRequest?: { requestedAt: number }) => {
    const automation = { target, ...(startRequest ? { startRequest } : {}) };
    render(renderCardMeta(createWorkboardCard({ metadata: { automation } }), false), container);
    return container.querySelector(".workboard-card__meta .workboard-card__queued");
  };

  expect(meta()).toBeNull();
  expect(meta({ requestedAt: 1 })?.textContent?.trim()).toBe("Queued");
});

it("links a card's draft PR by its number, and renders nothing before a PR exists", () => {
  const container = document.createElement("div");
  // Through the board's own normalization, which every card read passes.
  const pullRequestLink = (pullRequestUrl?: string) => {
    const [card] = normalizeCardsPayload({
      cards: [{ ...createWorkboardCard(), ...(pullRequestUrl ? { pullRequestUrl } : {}) }],
    }).cards;
    render(renderCardPullRequest(card!), container);
    return container.querySelector<HTMLAnchorElement>("a.workboard-card__pull-request");
  };
  expect(pullRequestLink()).toBeNull();
  expect(pullRequestLink("javascript:alert(1)")).toBeNull();
  expect(pullRequestLink("http://github.com/acme/app/pull/96")).toBeNull();

  const url = "https://github.com/acme/app/pull/96";
  const link = pullRequestLink(url)!;
  expect(link.href).toBe(url);
  expect(link.target).toBe("_blank");
  expect(link.textContent?.trim()).toBe("PR #96");
});

it("shortens a device-id node on the stage line and keeps the full id on hover", () => {
  const nodeId = "7ab5c2865e49b8cdc3d890d00d9a19767cfc0057936c87c86ebeef0cc70f5e03";
  const container = document.createElement("div");
  render(renderCardStage({ kind: "running", nodeId, attempt: 3 }, 0), container);
  const label = container.querySelector(".workboard-card__stage > span");
  expect(label?.textContent).toBe("Running on 7ab5c2865e49b8cd… · attempt 3");
  expect(label?.getAttribute("title")).toBe(nodeId);

  render(renderCardStage({ kind: "running", nodeId: "mac-factory" }, 0), container);
  expect(container.querySelector(".workboard-card__stage > span")?.textContent).toBe(
    "Running on mac-factory",
  );
});
