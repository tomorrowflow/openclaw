// Shows a card's stored diagnostic in the card detail against a mocked Gateway.
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
  name: "Workboard card diagnostics",
  startServerBeforeBrowser: true,
});

async function capture(page: Page, name: string) {
  if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
    await page
      .locator("#workboard-detail-panel-details")
      .screenshot({ path: path.join(suite.artifactDir, name), animations: "disabled" });
  }
}

suite.define(() => {
  it("lists a diagnostic with its first sighting only", async (test) => {
    await suite.runScenario(test, {
      run: async () => {
        await suite.withPage(
          { viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" },
          async ({ page }) => {
            const now = Date.now();
            const board = {
              id: "factory",
              name: "Factory",
              total: 1,
              active: 1,
              archived: 0,
              byStatus: { todo: 1 },
            };
            const card = {
              id: "fac-50",
              title: "[FAC-50] Spec merge watcher: GitHub query times out",
              status: "todo",
              priority: "normal",
              labels: [],
              position: 1,
              createdAt: now - 3 * 3_600_000,
              updatedAt: now - 2 * 3_600_000,
              agentId: "dev",
              metadata: {
                automation: { boardId: "factory" },
                diagnostics: [
                  {
                    kind: "stranded_ready",
                    severity: "warning",
                    title: "Assigned card is waiting",
                    detail: "The card has an assigned agent but has not been claimed recently.",
                    firstSeenAt: now - 3_600_000,
                    lastSeenAt: now - 3_600_000,
                    count: 1,
                    actions: [{ kind: "claim", label: "Claim card" }],
                  },
                ],
              },
            };
            await installMockGateway(page, {
              ...workboardUi,
              featureMethods: [
                ...defaultControlUiFeatureMethods,
                "workboard.boards.list",
                "workboard.cards.list",
              ],
              methodResponses: {
                "workboard.boards.list": { boards: [board] },
                "workboard.cards.list": {
                  boards: [board],
                  cards: [card],
                  statuses: ["todo", "running", "blocked", "done"],
                },
              },
            });

            await page.goto(`${suite.server.baseUrl}workboard/factory`);
            await page.getByText("[FAC-50] Spec merge watcher").first().click();
            await page.locator(".workboard-detail").waitFor();
            await page.locator("#workboard-detail-tab-details").click();
            const panel = page.locator("#workboard-detail-panel-details");
            const line = panel.locator("li", { hasText: "Assigned card is waiting" });
            await line.waitFor();
            await capture(page, "diagnostics.png");
            const text = (await line.textContent()) ?? "";
            expect(text).toContain("First seen");
            expect(text).not.toContain("occurrences");
            expect(text).not.toContain("Last seen");
          },
        );
      },
    });
  });
});
