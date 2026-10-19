import "../../test/dom.setup.ts";
import { render } from "@solidjs/web";
import { createComponent, flush, type Component } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { normalizeCardsPayload } from "../../lib/workboard/normalization.ts";
import { createWorkboardCard } from "../../lib/workboard/test/index-helpers.ts";
import { CardMeta, CardPullRequest, CardStage } from "./view-card-content.tsx";

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) {
    dispose();
  }
  vi.unstubAllGlobals();
});

function mount<Props extends object>(component: Component<Props>, props: Props) {
  const container = document.createElement("div");
  disposers.push(render(() => createComponent(component, props), container));
  flush();
  return container;
}

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
    () =>
      createComponent(CardMeta, {
        card: createWorkboardCard({ labels: ["alpha", "beta"] }),
        archived: false,
      }),
    container,
  );
  flush();
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
    root();
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
  const meta = (startRequest?: { requestedAt: number }) => {
    const automation = { target, ...(startRequest ? { startRequest } : {}) };
    const container = mount(CardMeta, {
      card: createWorkboardCard({ metadata: { automation } }),
      archived: false,
    });
    return container.querySelector(".workboard-card__meta .workboard-card__queued");
  };

  expect(meta()).toBeNull();
  expect(meta({ requestedAt: 1 })?.textContent?.trim()).toBe("Queued");
});

it("links a card's draft PR by its number, and renders nothing before a PR exists", () => {
  // Through the board's own normalization, which every card read passes.
  const pullRequestLink = (pullRequestUrl?: string) => {
    const [card] = normalizeCardsPayload({
      cards: [{ ...createWorkboardCard(), ...(pullRequestUrl ? { pullRequestUrl } : {}) }],
    }).cards;
    return mount(CardPullRequest, { card: card! }).querySelector<HTMLAnchorElement>(
      "a.workboard-card__pull-request",
    );
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
  const container = mount(CardStage, { stage: { kind: "running", nodeId, attempt: 3 }, now: 0 });
  const label = container.querySelector(".workboard-card__stage > span");
  expect(label?.textContent).toBe("Running on 7ab5c2865e49b8cd… · attempt 3");
  expect(label?.getAttribute("title")).toBe(nodeId);

  expect(
    mount(CardStage, {
      stage: { kind: "running", nodeId: "mac-factory" },
      now: 0,
    }).querySelector(".workboard-card__stage > span")?.textContent,
  ).toBe("Running on mac-factory");
});
