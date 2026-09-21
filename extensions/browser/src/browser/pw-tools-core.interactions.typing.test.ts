// Browser tests cover the per-keystroke pacing of slow type actions.
import { beforeEach, describe, expect, it, vi } from "vitest";

const pageState = vi.hoisted(() => ({
  page: null as Record<string, unknown> | null,
  locator: null as Record<string, unknown> | null,
}));

const sessionMocks = vi.hoisted(() => ({
  assertPageNavigationCompletedSafely: vi.fn(async () => {}),
  closeBlockedNavigationTarget: vi.fn(async () => {}),
  ensurePageState: vi.fn(() => ({})),
  forceDisconnectPlaywrightForTarget: vi.fn(async () => {}),
  getPageForTargetId: vi.fn(async () => {
    if (!pageState.page) {
      throw new Error("missing page");
    }
    return pageState.page;
  }),
  gotoPageWithNavigationGuard: vi.fn(async () => null),
  isBrowserObservedDialogBlockedError: vi.fn(() => false),
  isPolicyDenyNavigationError: vi.fn((_err: unknown) => false),
  markObservedDialogsHandledRemotelyForPage: vi.fn(() => ({})),
  quarantineBlockedNavigationTarget: vi.fn(async () => {}),
  refLocator: vi.fn(() => {
    if (!pageState.locator) {
      throw new Error("missing locator");
    }
    return pageState.locator;
  }),
  restoreRoleRefsForTarget: vi.fn(() => {}),
  storeRoleRefsForTarget: vi.fn(() => {}),
  wasBrowserNavigationSourcePreservedAfterPolicyDenial: vi.fn((_err: unknown) => false),
  withPageNavigationRequestGuard: vi.fn(
    async ({
      action,
      page,
    }: {
      action: (url: string) => Promise<unknown>;
      page: { url: () => string };
    }) => await action(page.url()),
  ),
}));

vi.mock("./pw-session.js", () => sessionMocks);

const { typeViaPlaywright } = await import("./pw-tools-core.interactions.actions.js");

const navigationOptions = () =>
  ({
    cdpUrl: "http://127.0.0.1:18792",
    targetId: "tab-1",
    ssrfPolicy: { allowPrivateNetwork: false },
  }) as const;

function installTypingPage(type: (value: string) => Promise<void>): void {
  pageState.page = { url: vi.fn(() => "https://example.com") };
  pageState.locator = {
    click: vi.fn(async () => {}),
    fill: vi.fn(async () => {}),
    press: vi.fn(async () => {}),
    type: vi.fn(type),
  };
}

describe("slow type pacing", () => {
  beforeEach(() => {
    pageState.page = null;
    pageState.locator = null;
    for (const fn of Object.values(sessionMocks)) {
      fn.mockClear();
    }
  });

  it("sends each character of the text as its own keystroke", async () => {
    const typed: string[] = [];
    installTypingPage(async (value) => {
      typed.push(value);
    });

    await typeViaPlaywright({
      ...navigationOptions(),
      ref: "1",
      text: "añ\u{1F600}",
      slowly: true,
    });

    // One call per character, in order, with surrogate pairs kept intact.
    expect(typed).toEqual(["a", "ñ", "\u{1F600}"]);
  });

  it("varies the pause between keystrokes instead of using a fixed delay", async () => {
    const gaps: number[] = [];
    let last = 0;
    installTypingPage(async () => {
      const now = Date.now();
      if (last) {
        gaps.push(now - last);
      }
      last = now;
    });

    await typeViaPlaywright({
      ...navigationOptions(),
      ref: "1",
      text: "abcdefghij",
      slowly: true,
    });

    expect(gaps).toHaveLength(9);
    // Bounds are generous: this asserts the pacing exists and is not constant,
    // not the exact distribution.
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(30);
      expect(gap).toBeLessThan(400);
    }
    expect(new Set(gaps).size).toBeGreaterThan(1);
  });

  it("stops part way through the text when the caller aborts", async () => {
    const ctrl = new AbortController();
    const typed: string[] = [];
    installTypingPage(async (value) => {
      typed.push(value);
      ctrl.abort(new Error("aborted by test"));
    });

    await expect(
      typeViaPlaywright({
        ...navigationOptions(),
        ref: "1",
        text: "abcdef",
        slowly: true,
        signal: ctrl.signal,
      }),
    ).rejects.toThrow("aborted by test");
    // The pause after the first keystroke observes the abort; nothing else is sent.
    expect(typed).toEqual(["a"]);
  });

  it("fills the field in one step when slow typing is not requested", async () => {
    const typed: string[] = [];
    installTypingPage(async (value) => {
      typed.push(value);
    });

    await typeViaPlaywright({ ...navigationOptions(), ref: "1", text: "abc" });

    expect(typed).toEqual([]);
    expect(pageState.locator?.fill).toHaveBeenCalledWith("abc", expect.anything());
  });
});
