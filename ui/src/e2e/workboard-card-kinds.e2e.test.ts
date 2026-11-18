// Shows each card kind on the board and filters by kind against a mocked Gateway.
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
  name: "Workboard card kinds",
  startServerBeforeBrowser: true,
});

async function capture(page: Page, name: string) {
  if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
    await page
      .locator(".workboard-board")
      .screenshot({ path: path.join(suite.artifactDir, name), animations: "disabled" });
  }
}

suite.define(() => {
  it("names every kind but a task on its card and filters the board by kind", async (test) => {
    await suite.runScenario(test, {
      run: async () => {
        await suite.withPage(
          { viewport: { width: 1440, height: 900 }, serviceWorkers: "block" },
          async ({ page }) => {
            const now = Date.now();
            const card = (
              id: string,
              title: string,
              status: string,
              kind: string | undefined,
              seq: number,
            ) => ({
              id,
              title,
              status,
              priority: "normal",
              labels: kind === "spec" || kind === "prototype" ? [] : ["class:web-logic"],
              ...(kind ? { kind } : {}),
              release: 2,
              seq,
              position: seq,
              createdAt: now - 3_600_000,
              updatedAt: now - 60_000,
              metadata: { automation: { boardId: "lindra" } },
            });
            const cards = [
              card("spec", "[LIN-2.00] Define the Arztbrief release", "done", "spec", 0),
              card("task", "[LIN-2.01] Case data: birth year and sex", "todo", undefined, 1),
              card(
                "proto",
                "[LIN-2.03] Prototype: reading review and letter view",
                "todo",
                "prototype",
                3,
              ),
              card(
                "research",
                "[LIN-2.14] Research: vision models for handwriting",
                "todo",
                "research",
                14,
              ),
              card("bug", "[LIN-2.15] Upload drops the second PDF page", "running", "bug", 15),
            ];
            const board = {
              id: "lindra",
              name: "Lindra",
              total: cards.length,
              active: cards.length,
              archived: 0,
              byStatus: { todo: 3, running: 1, done: 1 },
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
                  cards,
                  statuses: ["todo", "running", "done"],
                },
              },
            });

            await page.goto(`${suite.server.baseUrl}workboard/lindra`);
            await page.getByText("[LIN-2.01] Case data").first().waitFor();
            await capture(page, "board.png");
            await expect
              .poll(() => page.locator(".workboard-card__kind").allTextContents())
              .toEqual(["Prototype", "Research", "Bug", "Spec"]);
            const stripe = await page
              .locator('.workboard-card[data-kind="bug"]')
              .evaluate((node) => getComputedStyle(node, "::before").backgroundColor);
            expect(stripe).not.toBe("rgba(0, 0, 0, 0)");

            await page.getByRole("button", { name: "Filters" }).click();
            await page
              .locator('[role="group"][aria-label="Kind"] .workboard-filter-option')
              .filter({ hasText: "Bug" })
              .click();
            await expect
              .poll(() => page.locator(".workboard-board .workboard-card").count())
              .toBe(1);
            await page.keyboard.press("Escape");
            await capture(page, "filtered.png");
          },
        );
      },
    });
  });
});
