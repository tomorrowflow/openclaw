import "../../test/dom.setup.ts";
import { render } from "@solidjs/web";
import { createComponent, createSignal, flush, type Component } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { loadMessages } from "../../i18n/locales.ts";
import { normalizeCardsPayload } from "../../lib/workboard/normalization.ts";
import { createWorkboardCard } from "../../lib/workboard/test/index-helpers.ts";
import type { WorkboardCard } from "../../lib/workboard/types.ts";
import { workboardTestHost } from "../../test/host.setup.ts";
import { CardMeta, CardPullRequest, CardStage } from "./view-card-content.tsx";

const mountedRoots: Array<() => void> = [];
afterEach(() => {
  for (const dispose of mountedRoots.splice(0)) {
    dispose();
  }
  vi.unstubAllGlobals();
});

function mount<Props extends object>(component: Component<Props>, props: Props) {
  const container = document.createElement("div");
  mountedRoots.push(render(() => createComponent(component, props), container));
  flush();
  return container;
}

it("remeasures labels only when their contents, order, width, or locale change", async () => {
  let resize: ResizeObserverCallback = () => {};
  let frame: FrameRequestCallback = () => {};
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resize = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const requestFrame = vi.fn((callback: FrameRequestCallback) => {
    frame = callback;
    return 1;
  });
  vi.stubGlobal("requestAnimationFrame", requestFrame);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  const container = document.createElement("div");
  document.body.append(container);
  const [card, setCard] = createSignal(createWorkboardCard({ labels: ["alpha", "beta"] }));
  const root = render(
    () =>
      createComponent(CardMeta, {
        get card() {
          return card();
        },
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
  const measurements = chips.map((chip) =>
    vi.spyOn(chip, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 60, 24)),
  );
  const overflowMeasurement = vi
    .spyOn(overflow, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(0, 0, 20, 24));
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
    requestFrame.mockClear();
    measurements.forEach((measurement) => measurement.mockClear());
    overflowMeasurement.mockClear();
    setCard((current) => ({
      ...current,
      updatedAt: current.updatedAt + 1,
      labels: [...current.labels],
    }));
    flush();
    expect(requestFrame).not.toHaveBeenCalled();
    expect(measurements.every((measurement) => measurement.mock.calls.length === 0)).toBe(true);
    expect(overflowMeasurement).not.toHaveBeenCalled();
    expect([...labels.querySelectorAll(".workboard-card__label")]).toEqual(chips);
    expect(mutations.takeRecords()).toEqual([]);
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

    requestFrame.mockClear();
    setCard((current) => ({ ...current, labels: ["beta", "alpha"] }));
    flush();
    expect(requestFrame).toHaveBeenCalledTimes(1);
    expect([...labels.querySelectorAll(".workboard-card__label")]).toEqual([chips[1], chips[0]]);
    frame(0);
    expect(overflow.title).toBe("alpha");
    expect(chips.map((chip) => chip.hidden)).toEqual([true, false]);

    requestFrame.mockClear();
    setCard((current) => ({ ...current, labels: ["beta", "gamma"] }));
    flush();
    const currentChips = [...labels.querySelectorAll<HTMLElement>(".workboard-card__label")];
    expect(currentChips[0]).toBe(chips[1]);
    expect(currentChips.map((chip) => chip.textContent)).toEqual(["beta", "gamma"]);
    vi.spyOn(currentChips[1]!, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 60, 24));
    expect(requestFrame).toHaveBeenCalledTimes(1);
    frame(0);
    expect(overflow.title).toBe("gamma");
    expect(overflow.getAttribute("aria-label")).toBe("1 more labels: gamma");

    requestFrame.mockClear();
    const fixture = workboardTestHost();
    Object.assign(fixture.host, { locale: "fr" });
    fixture.notify();
    await loadMessages("fr");
    flush();
    expect(requestFrame).toHaveBeenCalled();
    frame(0);
    expect(overflow.getAttribute("aria-label")).toBe("1 étiquettes supplémentaires : gamma");
    Object.assign(fixture.host, { locale: "en" });
    fixture.notify();
    flush();
    frame(0);
    expect(overflow.getAttribute("aria-label")).toBe("1 more labels: gamma");
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
  const meta = (startRequest?: WorkboardCard["startRequest"]) => {
    const container = mount(CardMeta, {
      card: createWorkboardCard({ metadata: { automation: { target } }, startRequest }),
      archived: false,
    });
    return container.querySelector(".workboard-card__meta .workboard-card__queued");
  };

  expect(meta()).toBeNull();
  expect(meta({ requestedAt: 1, source: "operator" })?.textContent?.trim()).toBe("Queued");
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

it("shares label resize observation and retires targets independently", () => {
  const observers: TestResizeObserver[] = [];
  class TestResizeObserver implements ResizeObserver {
    readonly targets = new Set<Element>();
    constructor(readonly callback: ResizeObserverCallback) {
      observers.push(this);
    }
    observe(target: Element) {
      this.targets.add(target);
    }
    unobserve(target: Element) {
      this.targets.delete(target);
    }
    disconnect() {
      this.targets.clear();
    }
  }
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  const first = document.createElement("div");
  const second = document.createElement("div");
  document.body.append(first, second);
  const mountLabels = (container: HTMLElement, count: number) =>
    render(
      () =>
        Array.from({ length: count }, (_, index) =>
          createComponent(CardMeta, {
            card: createWorkboardCard({ id: `label-${index}`, labels: ["alpha", "beta"] }),
            archived: false,
          }),
        ),
      container,
    );
  const disposeFirst = mountLabels(first, 100);
  const disposeSecond = mountLabels(second, 20);
  flush();
  try {
    expect(first.querySelectorAll(".workboard-card__labels")).toHaveLength(100);
    expect(second.querySelectorAll(".workboard-card__labels")).toHaveLength(20);
    expect(observers).toHaveLength(1);
    expect(observers[0]!.targets.size).toBe(120);
    expect(
      [...observers[0]!.targets].every((target) => target.matches(".workboard-card__labels")),
    ).toBe(true);
    disposeFirst();
    expect(observers[0]!.targets.size).toBe(20);
    disposeSecond();
    expect(observers[0]!.targets.size).toBe(0);
  } finally {
    disposeFirst();
    disposeSecond();
  }
});

it("ignores a repeated retired ref cleanup after a sibling creates the next pool", () => {
  const observers: TestResizeObserver[] = [];
  class TestResizeObserver implements ResizeObserver {
    readonly targets = new Set<Element>();
    constructor() {
      observers.push(this);
    }
    observe(target: Element) {
      this.targets.add(target);
    }
    unobserve(target: Element) {
      this.targets.delete(target);
    }
    disconnect() {
      this.targets.clear();
    }
  }
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  const [card, setCard] = createSignal(createWorkboardCard({ labels: ["retiring"] }));
  const containers = Array.from({ length: 3 }, () => document.createElement("div"));
  document.body.append(...containers);
  const disposeFirst = render(
    () =>
      createComponent(CardMeta, {
        get card() {
          return card();
        },
        archived: false,
      }),
    containers[0]!,
  );
  const disposers = [disposeFirst];
  try {
    flush();
    expect(observers).toHaveLength(1);
    setCard(createWorkboardCard({ labels: [] }));
    flush();
    expect(observers[0]!.targets.size).toBe(0);
    disposers.push(
      render(
        () =>
          createComponent(CardMeta, {
            card: createWorkboardCard({ labels: ["surviving"] }),
            archived: false,
          }),
        containers[1]!,
      ),
    );
    flush();
    expect(observers).toHaveLength(2);
    disposeFirst();
    disposers.push(
      render(
        () =>
          createComponent(CardMeta, {
            card: createWorkboardCard({ labels: ["new sibling"] }),
            archived: false,
          }),
        containers[2]!,
      ),
    );
    flush();
    expect(observers).toHaveLength(2);
    expect(observers[1]!.targets.size).toBe(2);
  } finally {
    for (const dispose of disposers) {
      dispose();
    }
  }
});
