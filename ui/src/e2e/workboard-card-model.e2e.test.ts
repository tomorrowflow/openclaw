// Changes a node ticket's model from the card detail against a mocked Gateway.
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
  name: "Workboard card model",
  startServerBeforeBrowser: true,
});

const SONNET = "anthropic/claude-sonnet-5-5";
const FABLE = "anthropic/claude-fable-5-1";

async function capture(page: Page, name: string) {
  if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
    await page
      .locator(".workboard-detail")
      .screenshot({ path: path.join(suite.artifactDir, name), animations: "disabled" });
  }
}

suite.define(() => {
  it("switches a blocked node ticket to another model", async (test) => {
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
              byStatus: { blocked: 1 },
            };
            const card = {
              id: "lfr-02",
              title: "[LFR-02] Environments: compose and the runbook",
              status: "blocked",
              priority: "normal",
              labels: ["class:environment"],
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
                    model: FABLE,
                  },
                },
              },
            };
            const gateway = await installMockGateway(page, {
              ...workboardUi,
              featureMethods: [
                ...defaultControlUiFeatureMethods,
                "workboard.boards.list",
                "workboard.cards.list",
                "workboard.cards.setModel",
              ],
              methodResponses: {
                "workboard.boards.list": { boards: [board] },
                "workboard.cards.list": {
                  boards: [board],
                  cards: [card],
                  statuses: ["todo", "running", "blocked", "done"],
                },
                "models.list": {
                  models: [
                    { id: "claude-fable-5-1", name: "Claude Fable 5.1", provider: "anthropic" },
                    { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", provider: "anthropic" },
                  ],
                },
                "workboard.cards.setModel": {
                  card: {
                    ...card,
                    updatedAt: now,
                    metadata: {
                      automation: {
                        ...card.metadata.automation,
                        target: { ...card.metadata.automation.target, model: SONNET },
                      },
                    },
                  },
                },
              },
            });

            await page.goto(`${suite.server.baseUrl}workboard/lindra`);
            await page.getByText("[LFR-02] Environments").first().click();
            await page.locator(".workboard-detail").waitFor();
            const select = page.locator("select[data-card-model]");
            await expect.poll(() => select.inputValue()).toBe(FABLE);
            await select.focus();
            await expect.poll(() => select.locator("option").count()).toBe(2);
            await capture(page, "after-open.png");
            await select.selectOption(SONNET);
            await expect
              .poll(async () => (await gateway.getRequests("workboard.cards.setModel")).length)
              .toBe(1);
            expect(await gateway.getRequests("workboard.cards.setModel")).toMatchObject([
              { params: { id: "lfr-02", model: SONNET } },
            ]);
            await expect.poll(() => select.inputValue()).toBe(SONNET);
            await capture(page, "after.png");
          },
        );
      },
    });
  });
});
