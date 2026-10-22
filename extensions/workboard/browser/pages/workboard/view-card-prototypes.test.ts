import "../../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createWorkboardCard } from "../../lib/workboard/test/index-helpers.ts";
import { mountPage } from "./workboard-page.test-support.ts";

const LIST = "workboard.cards.prototypes.list";
const GET = "workboard.cards.prototypes.get";
const COMMIT = "b".repeat(40);

function nodeCard(commits: string[]) {
  return createWorkboardCard({
    id: "card-1",
    status: "running",
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
    rounds: commits.map((to, round) => ({
      round,
      changes: { from: "a".repeat(40), to, files: [], totals: { files: 1, added: 0, deleted: 0 } },
    })),
  });
}

type Handler = (params: Record<string, unknown>) => unknown;

/** A connected page with one node ticket's drawer open on the Prototype tab. */
function prototypesPage(handlers: { list: Handler; get: Handler }, card = nodeCard([COMMIT])) {
  const page = mountPage();
  const fallback = expectDefined(page.request.getMockImplementation(), "request implementation");
  page.request.mockImplementation(async (method, params) => {
    const input = (params ?? {}) as Record<string, unknown>;
    if (method === LIST) {
      return handlers.list(input);
    }
    if (method === GET) {
      return handlers.get(input);
    }
    return fallback(method, params);
  });
  page.cards([card]);
  page.workboard.state.detailCardId = "card-1";
  page.workboard.state.detailTab = "prototype";
  page.fixture.connection.connected = true;
  page.fixture.notify();
  return {
    ...page,
    calls: (method: string) => page.request.mock.calls.filter(([name]) => name === method),
    tab: () => page.container.querySelector("#workboard-detail-tab-prototype"),
    frame: () =>
      page.container.querySelector<HTMLIFrameElement>(
        "#workboard-detail-panel-prototype:not([hidden]) iframe",
      ),
    picker: () => page.container.querySelector<HTMLSelectElement>(".workboard-prototypes__picker"),
  };
}

const bothSources = () => ({
  committed: {
    state: "available",
    rounds: [{ round: 0, commit: COMMIT, paths: ["docs/prototypes/T-1/flow.html"] }],
  },
  live: {
    state: "available",
    files: [{ path: "docs/prototypes/T-1/draft.html", bytes: 10, mtimeMs: 5 }],
  },
});

const echo = (params: Record<string, unknown>) => ({ html: `<p>${String(params.path)}</p>` });

it("lists live and committed prototypes and renders the picked one in a script-only sandbox", async () => {
  const page = prototypesPage({ list: bothSources, get: echo });

  await vi.waitFor(() => expect(page.frame()).not.toBeNull());
  expect(page.calls(LIST).map(([, params]) => params)).toEqual([{ id: "card-1", live: true }]);
  const frame = expectDefined(page.frame(), "prototype frame");
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
  expect(frame.getAttribute("srcdoc")).toBe("<p>docs/prototypes/T-1/draft.html</p>");
  expect(page.request).toHaveBeenCalledWith(GET, {
    id: "card-1",
    live: true,
    path: "docs/prototypes/T-1/draft.html",
  });
  const picker = expectDefined(page.picker(), "picker");
  expect([...picker.options].map((option) => option.textContent)).toEqual([
    "Live · T-1/draft.html",
    "First run · T-1/flow.html",
  ]);

  picker.value = expectDefined(picker.options[1], "committed option").value;
  picker.dispatchEvent(new Event("change", { bubbles: true }));
  await vi.waitFor(() =>
    expect(page.frame()?.getAttribute("srcdoc")).toBe("<p>docs/prototypes/T-1/flow.html</p>"),
  );
  expect(page.request).toHaveBeenCalledWith(GET, {
    id: "card-1",
    round: 0,
    path: "docs/prototypes/T-1/flow.html",
  });
});

it("offers no Prototype tab when neither source lists a file", async () => {
  const page = prototypesPage(
    {
      list: () => ({
        committed: { state: "available", rounds: [] },
        live: { state: "available", files: [] },
      }),
      get: echo,
    },
    nodeCard([]),
  );

  await vi.waitFor(() => expect(page.calls(LIST)).toHaveLength(1));
  await vi.waitFor(() =>
    expect(
      page.container.querySelector("#workboard-detail-tab-overview")?.getAttribute("aria-selected"),
    ).toBe("true"),
  );
  expect(page.tab()).toBeNull();
  expect(page.calls(GET)).toHaveLength(0);
});

it("names a failed read instead of rendering an empty frame", async () => {
  const page = prototypesPage({
    list: bothSources,
    get: () => {
      throw new Error("prototype not found: live docs/prototypes/T-1/draft.html");
    },
  });

  await vi.waitFor(() =>
    expect(page.container.querySelector(".workboard-prototypes__placeholder")?.textContent).toBe(
      "Could not load this prototype: prototype not found: live docs/prototypes/T-1/draft.html",
    ),
  );
  expect(page.frame()).toBeNull();
});
