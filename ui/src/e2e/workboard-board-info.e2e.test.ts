// Opens the Workboard board-info popover and reveals a secret against a mocked Gateway.
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
  name: "Workboard board info",
  startServerBeforeBrowser: true,
});

const board = {
  id: "lindra",
  name: "Lindra",
  total: 0,
  active: 0,
  archived: 0,
  byStatus: {},
  orchestration: {
    defaultTarget: {
      kind: "node-claude",
      nodeId: "linux-node",
      repoPath: "/home/factory/repos/lindra",
      worktreesRoot: "/home/factory/worktrees",
      hostRepoPath: "/srv/repos/lindra",
    },
    links: [
      { label: "Test", url: "https://test.example.ts.net:8780", group: "Test" },
      { label: "Production", url: "https://prod.example.ts.net:8790", group: "Prod" },
    ],
    secrets: [{ label: "Test token", name: "LIN_TEST_TOKEN", group: "Test" }],
    env: {
      LINDRA_TEXT_URL: "http://gpu.example.ts.net:11434",
      LINDRA_TEXT_MODEL: "gpt-oss:20b",
    },
    preview: {
      up: ["docker compose up -d"],
      down: ["docker compose down"],
      ports: { from: 48600, to: 48619 },
      env: {
        LINDRA_PREVIEW_TOKEN: { source: "store", provider: "default", id: "LINDRA_PREVIEW_TOKEN" },
      },
    },
  },
};

async function capture(page: Page, name: string) {
  if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
    await page.screenshot({ path: path.join(suite.artifactDir, name), animations: "disabled" });
  }
}

async function openBoard(page: Page, operatorScopes: string[]) {
  const gateway = await installMockGateway(page, {
    ...workboardUi,
    operatorScopes,
    featureMethods: [
      ...defaultControlUiFeatureMethods,
      "workboard.boards.list",
      "workboard.cards.list",
      "workboard.boards.revealSecret",
      "workboard.architectureViewer",
      "workboard.cards.trust",
    ],
    methodResponses: {
      "workboard.boards.list": { boards: [board] },
      "workboard.cards.list": {
        boards: [board],
        cards: [],
        statuses: ["todo", "running", "blocked", "done"],
      },
      "workboard.architectureViewer": { port: 48700 },
      "workboard.cards.trust": {
        boardId: "lindra",
        generatedAt: 1,
        total: { tickets: 0 },
        classes: [],
        weeks: [],
      },
      "workboard.boards.revealSecret": { value: "tok-demo-1234" },
    },
  });
  await page.goto(`${suite.server.baseUrl}workboard/lindra`);
  await page.locator(".workboard-page-title").waitFor();
  return gateway;
}

suite.define(() => {
  it("lists board links and env, and reveals a secret for admins", async (test) => {
    await suite.runScenario(test, {
      run: async () => {
        await suite.withPage(
          { viewport: { width: 1280, height: 800 }, serviceWorkers: "block" },
          async ({ page }) => {
            const gateway = await openBoard(page, [
              "operator.admin",
              "operator.read",
              "operator.write",
            ]);
            const title = page.locator(".workboard-page-title");
            await expect.poll(() => title.locator(".workboard-board-architecture").count()).toBe(1);
            await capture(page, "after-header.png");
            await title.getByRole("button", { name: "Project links and secrets" }).click();
            const popover = page.locator("#workboard-board-info");
            await expect.poll(() => popover.getByText("tok-demo-1234").count()).toBe(0);
            await expect.poll(() => popover.getByText("gpt-oss:20b").count()).toBe(1);
            await capture(page, "after-popover.png");
            await popover.getByRole("button", { name: /Reveal/ }).click();
            await expect.poll(() => popover.getByText("tok-demo-1234").count()).toBe(1);
            expect(await gateway.getRequests("workboard.boards.revealSecret")).toMatchObject([
              { params: { boardId: "lindra", name: "LIN_TEST_TOKEN" } },
            ]);
            await capture(page, "after-revealed.png");
            await page.emulateMedia({ colorScheme: "dark" });
            await capture(page, "after-revealed-dark.png");
          },
        );
      },
    });
  });

  it("offers no reveal button without the admin scope", async (test) => {
    await suite.runScenario(test, {
      run: async () => {
        await suite.withPage(
          { viewport: { width: 1280, height: 800 }, serviceWorkers: "block" },
          async ({ page }) => {
            await openBoard(page, ["operator.read", "operator.write"]);
            await page.getByRole("button", { name: "Project links and secrets" }).click();
            const popover = page.locator("#workboard-board-info");
            await expect.poll(() => popover.getByText("Test token").count()).toBe(1);
            expect(await popover.getByRole("button", { name: /Reveal/ }).count()).toBe(0);
            await capture(page, "after-non-admin.png");
          },
        );
      },
    });
  });
});
