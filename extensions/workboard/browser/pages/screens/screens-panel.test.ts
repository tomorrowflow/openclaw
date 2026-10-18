import "../../test/dom.setup.ts";
import type { WorkboardScreenshotListResult } from "@openclaw/workboard-contract";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createWorkboardCapability } from "../../lib/workboard/capability.ts";
import { createWorkboardCard } from "../../lib/workboard/test/index-helpers.ts";
import { workboardTestHost } from "../../test/host.setup.ts";
import { createViewContext } from "../../test/host.ts";
import { createScreensPanel } from "./screens-panel.ts";

const LIST = "workboard.cards.screenshots.list";
const GET = "workboard.cards.screenshots.get";
const SESSION = "agent:dev:workboard:card-1";

beforeEach(() => {
  vi.stubGlobal(
    "URL",
    class extends URL {
      static override createObjectURL = () => "blob:shot";
      static override revokeObjectURL = () => undefined;
    },
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function nodeCard(status: "running" | "review" = "running") {
  return createWorkboardCard({
    status,
    sessionKey: SESSION,
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
  });
}

/** The Screens panel for one session, its Gateway answering the list with `listed`. */
function mountPanel(
  listed: () => WorkboardScreenshotListResult | Promise<WorkboardScreenshotListResult>,
  cards = [nodeCard()],
) {
  const fixture = workboardTestHost();
  fixture.connection.connected = true;
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) =>
    method === LIST
      ? listed()
      : method === GET
        ? { mimeType: "image/png", contentBase64: btoa(String(params?.path)) }
        : {},
  );
  fixture.host.request = request as typeof fixture.host.request;
  const workboard = createWorkboardCapability();
  workboard.state.cards = cards;
  const container = document.createElement("div");
  const mounted = createScreensPanel(workboard)(
    container,
    createViewContext(fixture.host, { sessionKey: SESSION }),
  );
  return {
    container,
    workboard,
    calls: (method: string) => request.mock.calls.filter(([name]) => name === method),
    present: (presented: boolean) =>
      mounted?.update?.(createViewContext(fixture.host, { sessionKey: SESSION }, presented)),
    dispose: () => mounted?.dispose?.(),
  };
}

const ROUND = { round: 0, commit: "b".repeat(40), paths: ["docs/screenshots/T-1/done.png"] };

it("shows the agent's live screenshots above each round's committed ones", async () => {
  const panel = mountPanel(() => ({
    committed: { state: "available", rounds: [ROUND] },
    live: {
      state: "available",
      shots: [
        { path: "features/evidence/ios-run-2/login.png", bytes: 10, mtimeMs: 2 },
        { path: "docs/screenshots/T-1/home.png", bytes: 10, mtimeMs: 1 },
      ],
    },
  }));
  try {
    await vi.waitFor(() => expect(panel.container.querySelectorAll("img")).toHaveLength(3));
    expect(
      [...panel.container.querySelectorAll("img")].map((image) => image.getAttribute("alt")),
    ).toEqual(["login.png", "home.png", "done.png"]);
    expect(panel.container.textContent).toContain("Listed just now");
    expect(panel.calls(LIST).map(([, params]) => params)).toEqual([{ id: "card-1", live: true }]);
    expect(panel.calls(GET).map(([, params]) => params)).toEqual([
      { id: "card-1", live: true, path: "features/evidence/ios-run-2/login.png" },
      { id: "card-1", live: true, path: "docs/screenshots/T-1/home.png" },
      { id: "card-1", round: 0, path: "docs/screenshots/T-1/done.png" },
    ]);
  } finally {
    panel.dispose();
  }
});

it("names why live screenshots are unavailable and still shows the committed rounds", async () => {
  const reason =
    "node mac-factory could not list /wt/wb-card-1/docs/screenshots: PATH_POLICY_DENIED. Check the grants.";
  const panel = mountPanel(() => ({
    committed: { state: "available", rounds: [ROUND] },
    live: { state: "unavailable", reason },
  }));
  try {
    await vi.waitFor(() => expect(panel.container.querySelectorAll("img")).toHaveLength(1));
    expect(panel.container.querySelector(".workboard-screens__unavailable")?.textContent).toBe(
      `Live screenshots unavailable: ${reason}`,
    );
  } finally {
    panel.dispose();
  }
});

it("lists again every 20 seconds only while shown and the ticket runs", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const panel = mountPanel(() => ({
    committed: { state: "available", rounds: [] },
    live: { state: "available", shots: [] },
  }));
  try {
    expect(panel.calls(LIST)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(panel.calls(LIST)).toHaveLength(2);

    panel.present(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(panel.calls(LIST)).toHaveLength(2);

    panel.present(true);
    expect(panel.calls(LIST)).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(panel.calls(LIST)).toHaveLength(4);

    panel.workboard.state.cards = [nodeCard("review")];
    panel.workboard.notify();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(panel.calls(LIST)).toHaveLength(4);

    panel.workboard.state.cards = [nodeCard("running")];
    panel.workboard.notify();
    panel.dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(panel.calls(LIST)).toHaveLength(4);
  } finally {
    panel.dispose();
  }
});

it("skips a tick while the previous list is still loading", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const panel = mountPanel(() => new Promise<WorkboardScreenshotListResult>(() => {}));
  try {
    expect(panel.calls(LIST)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(panel.calls(LIST)).toHaveLength(1);
  } finally {
    panel.dispose();
  }
});
