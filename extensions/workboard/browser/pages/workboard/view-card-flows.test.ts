import "../../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createWorkboardCard } from "../../lib/workboard/test/index-helpers.ts";
import { mountPage } from "./workboard-page.test-support.ts";

const LIST = "workboard.cards.flows.list";
const GET = "workboard.cards.flows.get";
const LOCATE = "workboard.cards.screenshots.locate";
const COMMIT = "b".repeat(40);
const REPORT = "docs/flows/dictation.html";
const ON_BASE = "docs/screenshots/LIN-2.04/dictation-ipad-B.png";
const LINKED = "docs/screenshots/PROTO-1/sketch.png";
const MISSING = "docs/screenshots/LIN-9/gone.png";
const HTML = `<a href="../screenshots/LIN-2.04/dictation-ipad-B.png">iPad</a>
<a href="../screenshots/PROTO-1/sketch.png">sketch</a>
<a href="../screenshots/LIN-9/gone.png">gone</a>
<a href="https://example.com/">elsewhere</a>`;

type Handler = (params: Record<string, unknown>) => unknown;

/** A connected page with one node ticket's drawer open on the Flows tab. */
function flowsPage(handlers: { list: Handler; get?: Handler; locate?: Handler }) {
  const page = mountPage();
  const fallback = expectDefined(page.request.getMockImplementation(), "request implementation");
  page.request.mockImplementation(async (method, params) => {
    const input = (params ?? {}) as Record<string, unknown>;
    if (method === LIST) {
      return handlers.list(input);
    }
    if (method === GET) {
      return (handlers.get ?? (() => ({ html: HTML })))(input);
    }
    if (method === LOCATE) {
      return (
        handlers.locate ??
        (() => ({
          files: [
            { path: ON_BASE, source: { base: true } },
            { path: LINKED, cardId: "proto-1", source: { round: 0 } },
            { path: MISSING },
          ],
        }))
      )(input);
    }
    return fallback(method, params);
  });
  page.cards([
    createWorkboardCard({
      id: "card-1",
      status: "review",
      metadata: {
        automation: {
          target: {
            kind: "node-claude",
            nodeId: "mac-factory",
            repoPath: "/repo",
            worktreesRoot: "/wt",
            hostRepoPath: "/host",
          },
        },
      },
      rounds: [
        {
          round: 0,
          changes: {
            from: "a".repeat(40),
            to: COMMIT,
            files: [],
            totals: { files: 1, added: 0, deleted: 0 },
          },
        },
      ],
    }),
  ]);
  page.workboard.state.detailCardId = "card-1";
  page.workboard.state.detailTab = "flows";
  page.fixture.connection.connected = true;
  page.fixture.notify();
  const panel = () =>
    page.container.querySelector<HTMLElement>("#workboard-detail-panel-flows:not([hidden])");
  return {
    ...page,
    calls: (method: string) =>
      page.request.mock.calls.filter(([name]) => name === method).map(([, input]) => input),
    tab: () => page.container.querySelector("#workboard-detail-tab-flows"),
    panel,
    preview: () => panel()?.querySelector<HTMLElement>("[data-test-html-preview]"),
    shots: () =>
      [...(panel()?.querySelectorAll(".workboard-flows__screenshots li") ?? [])].map((item) => ({
        text: item.textContent,
        href: item.querySelector("a")?.getAttribute("href") ?? null,
      })),
  };
}

const oneReport = () => ({
  committed: { state: "available", rounds: [{ round: 0, commit: COMMIT, paths: [REPORT] }] },
  live: { state: "none" },
});

const popout = (card: string, source: string, path: string) =>
  `/screenshot?${new URLSearchParams({ card, source, path })}`;

it("shows a Flows tab with the report and where each screenshot it links to is found", async () => {
  const page = flowsPage({ list: oneReport });

  await vi.waitFor(() => expect(page.preview()?.dataset.html).toBe(HTML));
  expect(page.tab()?.textContent).toBe("Flows");
  expect(page.calls(LIST)).toEqual([{ id: "card-1", live: true }]);
  expect(page.calls(GET)).toEqual([{ id: "card-1", round: 0, path: REPORT }]);
  expect(page.calls(LOCATE)).toEqual([{ id: "card-1", paths: [ON_BASE, LINKED, MISSING] }]);
  expect(page.shots()).toEqual([
    { text: "dictation-ipad-B.png · default branch", href: popout("card-1", "base", ON_BASE) },
    { text: "sketch.png · linked card", href: popout("proto-1", "0", LINKED) },
    { text: "gone.png · missing", href: null },
  ]);
});

it("opens a clicked screenshot link's pop-out page, and names a link it does not follow", async () => {
  const page = flowsPage({ list: oneReport });
  await vi.waitFor(() => expect(page.preview()?.dataset.html).toBe(HTML));
  const click = (href: string) => {
    const props = vi.mocked(page.fixture.host.components.mountHtmlPreview).mock.lastCall?.[1];
    expectDefined(props?.onLink, "preview onLink")(href);
  };
  const note = () => page.panel()?.querySelector(".workboard-flows__note");
  const opened: string[] = [];
  const open = vi.spyOn(window, "open").mockImplementation((url) => {
    opened.push(String(url));
    return window;
  });
  try {
    click("../screenshots/LIN-2.04/dictation-ipad-B.png");
    expect(opened).toEqual([popout("card-1", "base", ON_BASE)]);
    expect(note()).toBeNull();

    // The report's scripts can send any string: only a located screenshot's own page opens.
    for (const href of [
      "https://example.com/x.png",
      " javascript:alert(1)",
      "../prototypes/x.html",
    ]) {
      click(href);
      await vi.waitFor(() =>
        expect(note()?.textContent).toContain(
          `Not opened: ${href}. Only links to images under docs/screenshots open from a flow report.`,
        ),
      );
    }
    click("../screenshots/LIN-9/gone.png");
    await vi.waitFor(() =>
      expect(note()?.textContent).toContain(
        `${MISSING} is not in this card's rounds, its linked cards, or the default branch of the Gateway's clone.`,
      ),
    );
    expect(opened).toHaveLength(1);

    // A refused window leaves the same address to click.
    open.mockImplementation(() => null);
    click("../screenshots/PROTO-1/sketch.png");
    await vi.waitFor(() =>
      expect(note()?.querySelector("a")?.getAttribute("href")).toBe(popout("proto-1", "0", LINKED)),
    );
    expect(note()?.textContent).toContain(`The browser blocked the new window for ${LINKED}.`);
  } finally {
    open.mockRestore();
  }
});

it("offers no Flows tab for a card without a flow report", async () => {
  const page = flowsPage({
    list: () => ({ committed: { state: "available", rounds: [] }, live: { state: "none" } }),
  });

  await vi.waitFor(() => expect(page.calls(LIST)).toHaveLength(1));
  await vi.waitFor(() =>
    expect(
      page.container.querySelector("#workboard-detail-tab-overview")?.getAttribute("aria-selected"),
    ).toBe("true"),
  );
  expect(page.tab()).toBeNull();
  expect(page.calls(GET)).toHaveLength(0);
});
