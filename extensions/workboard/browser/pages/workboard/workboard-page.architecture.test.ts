import "../../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { mountPage } from "./workboard-page.test-support.ts";

const TARGET = {
  kind: "node-claude" as const,
  nodeId: "node-1",
  repoPath: "/repo",
  worktreesRoot: "/worktrees",
  hostRepoPath: "/host/repo",
};

function mountBoard(board: Record<string, unknown>, port: number | null, canWrite = true) {
  const page = mountPage({ boardId: "app", architectureViewerPort: port });
  const request = expectDefined(page.request.getMockImplementation(), "request implementation");
  page.request.mockImplementation(async (method, params) => {
    if (method === "workboard.cards.list") {
      return {
        cards: [],
        boards: [
          { id: "app", name: "App", total: 0, active: 0, archived: 0, byStatus: {}, ...board },
        ],
      };
    }
    if (method === "workboard.cards.trust") {
      return { boardId: "app", generatedAt: 1, total: { tickets: 0 }, classes: [], weeks: [] };
    }
    if (method === "portal.open") {
      return { tokenQuery: "openclaw_portal=token", publicUrl: "https://gateway.example:35535/" };
    }
    return request(method, params);
  });
  page.fixture.connection.canWrite = canWrite;
  page.fixture.connection.connected = true;
  page.fixture.notify();
  return {
    ...page,
    button: () => page.container.querySelector<HTMLButtonElement>(".workboard-board-architecture"),
  };
}

it("opens a project board's architecture map through a portal", async () => {
  const page = mountBoard({ orchestration: { defaultTarget: TARGET } }, 17318);
  const tab = { opener: window as Window | null, location: { href: "" }, close: vi.fn() };
  const open = vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
  try {
    await vi.waitFor(() => expect(page.button()).not.toBeNull());
    expect(page.button()?.getAttribute("aria-label")).toBe("Open this board's architecture map");
    page.button()!.click();
    await vi.waitFor(() =>
      expect(tab.location.href).toBe(
        "https://gateway.example:35535/board/app/?openclaw_portal=token",
      ),
    );
    expect(page.request).toHaveBeenCalledWith("portal.open", {
      port: 17318,
      title: "Architecture map",
    });
    expect(tab.opener).toBeNull();
  } finally {
    open.mockRestore();
  }
});

it.each([
  ["a board without a node target", {}, 17318, true],
  ["no configured viewer", { orchestration: { defaultTarget: TARGET } }, null, true],
  ["a read-only operator", { orchestration: { defaultTarget: TARGET } }, 17318, false],
] as const)("shows no architecture button for %s", async (_case, board, port, canWrite) => {
  const page = mountBoard(board, port, canWrite);
  await vi.waitFor(() =>
    expect(page.container.querySelector(".workboard-page-title")?.textContent).toContain("App"),
  );
  expect(page.button()).toBeNull();
});
