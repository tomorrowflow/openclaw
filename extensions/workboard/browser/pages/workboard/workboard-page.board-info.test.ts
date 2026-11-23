import "../../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { mountPage } from "./workboard-page.test-support.ts";

const orchestration = {
  links: [{ label: "Test site", url: "https://test.example.ts.net:8780", group: "Test" }],
  secrets: [{ label: "Test token", name: "LIN_TEST_TOKEN", group: "Test" }],
  env: { LINDRA_TEXT_URL: "http://192.0.2.17:11434" },
};

function mountBoard(board: Record<string, unknown>, canAdmin: boolean) {
  const page = mountPage({ boardId: "app" });
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
    if (method === "workboard.boards.revealSecret") {
      return { value: "s3cret" };
    }
    return request(method, params);
  });
  page.fixture.connection.canAdmin = canAdmin;
  page.fixture.connection.connected = true;
  page.fixture.notify();
  return page;
}

// The browser e2e proves listing, reveal, and the non-admin view; these cover what it does not.
it("opens as an expanded dialog, links safely, and drops a revealed value when it closes", async () => {
  const page = mountBoard({ orchestration }, true);
  await vi.waitFor(() =>
    expect(page.container.querySelector(".workboard-board-info")).not.toBeNull(),
  );
  const button = page.container.querySelector(".workboard-board-info-button")!;
  expect(button.getAttribute("aria-expanded")).toBe("false");
  const panel = page.container.querySelector<HTMLElement>(".workboard-board-info")!;
  panel.showPopover();
  await vi.waitFor(() => expect(panel.textContent).toContain("Test site"));
  expect(button.getAttribute("aria-expanded")).toBe("true");
  expect(panel.querySelector("a")?.getAttribute("rel")).toBe("noopener noreferrer");
  panel.querySelector<HTMLButtonElement>('button[aria-label="Reveal Test token"]')!.click();
  await vi.waitFor(() => expect(panel.textContent).toContain("s3cret"));
  panel.hidePopover();
  await vi.waitFor(() => expect(panel.textContent).not.toContain("s3cret"));
  expect(button.getAttribute("aria-expanded")).toBe("false");
});

it("shows no info button for a board with nothing to list", async () => {
  const bare = mountBoard({}, true);
  await vi.waitFor(() =>
    expect(bare.container.querySelector(".workboard-page-title")?.textContent).toContain("App"),
  );
  expect(bare.container.querySelector(".workboard-board-info-button")).toBeNull();
  expect(bare.container.querySelector(".workboard-board-info")).toBeNull();
});
