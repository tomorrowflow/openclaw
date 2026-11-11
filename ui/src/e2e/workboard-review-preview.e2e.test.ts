// Opens a node ticket's review preview from the card detail, and retries a failed one, against a mocked Gateway.
import path from "node:path";
import type { Page } from "playwright-core";
import { expect, it } from "vitest";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { workboardUi } from "../test-helpers/control-ui-workboard-fixture.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Workboard review preview",
  startServerBeforeBrowser: true,
});

const URL = "https://linux-node.tail1234.ts.net:48600";

async function capture(page: Page, name: string) {
  if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
    await page
      .locator(".workboard-detail")
      .screenshot({ path: path.join(suite.artifactDir, name), animations: "disabled" });
  }
}

suite.define(() => {
  it("links a running preview and retries a failed one", async (test) => {
    await suite.runScenario(test, {
      run: async () => {
        await suite.withPage(
          { viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" },
          async ({ page }) => {
            const now = Date.now();
            const board = {
              id: "lindra",
              name: "Lindra",
              total: 1,
              active: 1,
              archived: 0,
              byStatus: { review: 1 },
            };
            const preview = {
              headCommit: "4f2a9c1e".padEnd(40, "0"),
              nodeId: "linux-node",
              path: "/home/factory/worktrees/wb-lfr-07-preview",
              down: ["python3", "scripts/env.py", "down", "--project", "lindra-pv-lfr-07"],
              port: 48600,
              at: now - 60_000,
            };
            const card = {
              id: "lfr-07",
              title: "[LFR-07] Voice capture: record from the iPad",
              status: "review",
              priority: "normal",
              labels: ["class:feature"],
              position: 1,
              createdAt: now - 3_600_000,
              updatedAt: now - 60_000,
              agentId: "dev",
              metadata: {
                automation: {
                  boardId: "lindra",
                  target: {
                    kind: "node-claude",
                    nodeId: "linux-node",
                    repoPath: "/home/factory/repos/lindra",
                    worktreesRoot: "/home/factory/worktrees",
                    hostRepoPath: "/srv/repos/lindra",
                  },
                },
              },
            };
            const failed = {
              ...card,
              preview: {
                ...preview,
                state: "failed",
                error:
                  "The board's preview up failed on linux-node: …Bind for 127.0.0.1:48600 failed: port is already allocated. Fix the stack or the board's preview.up, then Retry.",
              },
            };
            const gateway = await installMockGateway(page, {
              ...workboardUi,
              featureMethods: [
                ...defaultControlUiFeatureMethods,
                "workboard.boards.list",
                "workboard.cards.list",
                "workboard.cards.preview.retry",
              ],
              methodResponses: {
                "workboard.boards.list": { boards: [board] },
                "workboard.cards.list": {
                  boards: [board],
                  cards: [failed],
                  statuses: ["todo", "running", "review", "done"],
                },
                "workboard.cards.preview.retry": {
                  card: {
                    ...card,
                    updatedAt: now,
                    preview: { ...preview, state: "up", url: URL, at: now },
                  },
                },
              },
            });

            await page.goto(`${suite.server.baseUrl}workboard/lindra`);
            await page.getByText("[LFR-07] Voice capture").first().click();
            await page.locator(".workboard-detail").waitFor();
            await page.getByRole("tab", { name: "Preview" }).click();
            const panel = page.locator("#workboard-detail-panel-preview");
            await expect
              .poll(() => panel.locator(".workboard-preview__error").textContent())
              .toContain("port is already allocated");
            await capture(page, "preview-failed.png");

            await panel.locator("[data-preview-action=retry]").click();
            await expect
              .poll(async () => (await gateway.getRequests("workboard.cards.preview.retry")).length)
              .toBe(1);
            expect(await gateway.getRequests("workboard.cards.preview.retry")).toMatchObject([
              { params: { id: "lfr-07" } },
            ]);
            const link = panel.locator("[data-preview-action=open]");
            await expect.poll(() => link.getAttribute("href")).toBe(URL);
            expect(await link.getAttribute("target")).toBe("_blank");
            expect(await link.getAttribute("rel")).toBe("noopener");
            await capture(page, "preview-up.png");
            await page.setViewportSize({ width: 480, height: 900 });
            await capture(page, "preview-up-narrow.png");
          },
        );
      },
    });
  });
});
