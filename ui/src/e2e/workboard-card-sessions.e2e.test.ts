// Lists a node ticket's sessions by round in the card detail, blind for the undecided round, against a mocked Gateway.
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
  name: "Workboard card sessions",
  startServerBeforeBrowser: true,
});

const IMPLEMENTER = "agent:dev:subagent:workboard-lindra-lfr-07";

async function capture(page: Page, name: string) {
  if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
    await page
      .locator(".workboard-detail")
      .screenshot({ path: path.join(suite.artifactDir, name), animations: "disabled" });
  }
}

suite.define(() => {
  it("heads the card with its stage and opens each visible session once", async (test) => {
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
            const card = {
              id: "lfr-07",
              title: "[LFR-07] Voice capture: record from the iPad",
              status: "review",
              priority: "normal",
              labels: ["class:feature"],
              position: 1,
              createdAt: now - 7_200_000,
              updatedAt: now - 60_000,
              agentId: "dev",
              sessionKey: IMPLEMENTER,
              runId: "run-lfr-07-r1",
              stage: { kind: "awaiting_review", since: now - 25 * 60_000 },
              sessions: [
                { role: "implementer", round: 0, state: "finished", sessionKey: IMPLEMENTER },
                {
                  role: "verifier",
                  round: 0,
                  state: "finished",
                  sessionKey: "agent:verifier:verify-lfr-07-r0-v0",
                },
                {
                  role: "verdict",
                  round: 0,
                  state: "finished",
                  sessionKey: "agent:dev:workboard-review",
                },
                { role: "implementer", round: 1, state: "finished", sessionKey: IMPLEMENTER },
                { role: "verifier", round: 1, state: "finished", blind: true },
                { role: "verdict", round: 1, state: "finished", blind: true },
              ],
              metadata: {
                attempts: [
                  {
                    id: "attempt-1",
                    status: "succeeded",
                    startedAt: now - 7_000_000,
                    endedAt: now - 5_000_000,
                    sessionKey: IMPLEMENTER,
                    runId: "run-lfr-07-r0",
                  },
                  {
                    id: "attempt-2",
                    status: "succeeded",
                    startedAt: now - 3_000_000,
                    endedAt: now - 1_800_000,
                    sessionKey: IMPLEMENTER,
                    runId: "run-lfr-07-r1",
                  },
                ],
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
                  statuses: ["todo", "running", "review", "done"],
                },
              },
            });

            await page.goto(`${suite.server.baseUrl}workboard/lindra`);
            await page.getByText("[LFR-07] Voice capture").first().click();
            const detail = page.locator(".workboard-detail");
            await detail.waitFor();
            await capture(page, "detail-header.png");
            await page.getByRole("tab", { name: "Details" }).click();
            const panel = page.locator("#workboard-detail-panel-details");
            await panel.waitFor();
            await capture(page, "technical-details.png");

            await expect
              .poll(() =>
                detail.locator(".workboard-detail__header .workboard-card__stage").textContent(),
              )
              .toContain("Ready for your decision");
            const rounds = panel.locator(".workboard-detail__sessions details");
            expect(await rounds.count()).toBe(2);
            expect(await rounds.nth(0).getAttribute("open")).not.toBeNull();
            expect(await rounds.nth(1).getAttribute("open")).toBeNull();
            const current = rounds.nth(0).locator("li");
            expect(await current.allTextContents()).toEqual([
              "ImplementerFinishedOpen session",
              "VerifierFinishedHidden until you decide this round",
              "VerdictFinishedHidden until you decide this round",
            ]);
            expect(await rounds.nth(0).locator("button").count()).toBe(1);
            expect(await panel.textContent()).not.toContain("run-lfr-07-r1");
            await rounds.nth(1).locator("summary").click();
            expect(await rounds.nth(1).locator("button").count()).toBe(3);
            await capture(page, "technical-details-expanded.png");
          },
        );
      },
    });
  });
});
