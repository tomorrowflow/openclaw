// Shows a node ticket's flow report through the real sandbox listener; its links open the screenshots' pop-out page.
import type { Server } from "node:http";
import path from "node:path";
import type { Page } from "playwright-core";
import { expect, it } from "vitest";
import { buildSandboxHostPath } from "../../../src/agents/sandbox-host.js";
import { createSandboxHostHttpServer } from "../../../src/gateway/mcp-app-sandbox-http.js";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { workboardUi } from "../test-helpers/control-ui-workboard-fixture.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Workboard flow reports",
  startServerBeforeBrowser: true,
});

const CARD_ID = "state-flow";
const REPORT = "docs/flows/dictation.html";
const OWN = "docs/screenshots/FLOW-1/own.png";
const ON_BASE = "docs/screenshots/LIN-2.04/dictation-ipad-B.png";
const MISSING = "docs/screenshots/LIN-9/gone.png";
const COMMIT = "b71d0c33e9fa";

const REPORT_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Dictation flow</title>
<style>body { font: 15px/1.5 system-ui, sans-serif; margin: 0; padding: 24px; }</style></head>
<body>
  <h1>Dictation flow</h1>
  <ol>
    <li><a href="../screenshots/LIN-2.04/dictation-ipad-B.png">Dictation on iPad</a></li>
    <li><a href="../screenshots/FLOW-1/own.png">This round's capture</a></li>
    <li><a href="../screenshots/LIN-9/gone.png">Summary screen</a></li>
    <li><a href="../prototypes/ONB-4/checklist.html">Onboarding checklist</a></li>
  </ol>
</body></html>`;

async function listen(server: Server): Promise<number> {
  return await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Sandbox listener unavailable"));
      } else {
        resolve(address.port);
      }
    });
  });
}

/** A real PNG, so the pop-out page has natural dimensions to show at full size. */
async function capturePng(page: Page): Promise<string> {
  await page.setContent(
    '<body style="margin:0"><div style="display:grid;place-items:center;width:640px;height:480px;background:#1d4ed8;color:#fff;font:600 32px system-ui">Dictation · iPad · B</div></body>',
  );
  const png = await page.screenshot({ clip: { x: 0, y: 0, width: 640, height: 480 } });
  return png.toString("base64");
}

async function capture(page: Page, name: string) {
  if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
    await page.screenshot({ path: path.join(suite.artifactDir, name), animations: "disabled" });
  }
}

function popoutParams(href: string | null) {
  return Object.fromEntries(new URL(href ?? "", suite.server.baseUrl).searchParams);
}

suite.define(() => {
  it("lists a flow report's screenshots by source and opens one in the pop-out page", async (test) => {
    let sandbox: Server | undefined;
    await suite.runScenario(test, {
      run: async () => {
        sandbox = createSandboxHostHttpServer();
        const sandboxPort = await listen(sandbox);
        await suite.withPage(
          {
            viewport: { width: 1440, height: 1000 },
            serviceWorkers: "block",
            permissions: ["local-network-access"],
          },
          async ({ page }) => {
            const now = Date.now();
            const contentBase64 = await capturePng(page);
            const board = {
              id: "card-states",
              name: "Card states",
              total: 1,
              active: 1,
              archived: 0,
              byStatus: { review: 1 },
            };
            const card = {
              id: CARD_ID,
              title: "Report the dictation flow",
              status: "review",
              priority: "normal",
              labels: [],
              position: 1,
              createdAt: now - 3_600_000,
              updatedAt: now - 60_000,
              agentId: "main",
              metadata: {
                automation: {
                  boardId: "card-states",
                  target: {
                    kind: "node-claude",
                    nodeId: "mock-node",
                    repoPath: "/repos/app",
                    worktreesRoot: "/worktrees",
                    hostRepoPath: "/host/repos/app",
                  },
                },
              },
              rounds: [
                {
                  round: 0,
                  changes: {
                    from: "4f1c2a9e0b7d",
                    to: COMMIT,
                    files: [{ path: REPORT, added: 12, deleted: 0 }],
                    totals: { files: 2, added: 12, deleted: 0 },
                  },
                },
              ],
            };
            const round = (paths: string[]) => ({
              committed: { state: "available", rounds: [{ round: 0, commit: COMMIT, paths }] },
            });
            const gateway = await installMockGateway(page, {
              ...workboardUi,
              featureMethods: [
                ...defaultControlUiFeatureMethods,
                "canvas.document.preview",
                "workboard.boards.list",
                "workboard.cards.list",
              ],
              methodResponses: {
                "workboard.boards.list": { boards: [board] },
                "workboard.cards.list": {
                  boards: [board],
                  cards: [card],
                  statuses: ["todo", "review", "done"],
                },
                "workboard.cards.prototypes.list": {
                  committed: { state: "available", rounds: [] },
                },
                "workboard.cards.screenshots.list": round([OWN]),
                "workboard.cards.screenshots.get": { mimeType: "image/png", contentBase64 },
                "workboard.cards.flows.list": { ...round([REPORT]), live: { state: "none" } },
                "workboard.cards.flows.get": { html: REPORT_HTML },
                "workboard.cards.screenshots.locate": {
                  files: [
                    { path: ON_BASE, source: { base: true } },
                    { path: OWN, source: { round: 0 } },
                    { path: MISSING },
                  ],
                },
                "canvas.document.preview": {
                  html: REPORT_HTML,
                  sandboxUrl: buildSandboxHostPath({ blockDescendantFrames: true }),
                  sandboxPort,
                  sandboxOrigin: `http://127.0.0.1:${sandboxPort}`,
                },
              },
            });

            await page.goto(`${suite.server.baseUrl}workboard/card-states`);
            await page.getByText("Report the dictation flow").first().click();
            await page.locator("#workboard-detail-tab-flows").click();
            const panel = page.locator("#workboard-detail-panel-flows");
            const report = panel
              .locator("iframe.chat-html-preview__frame")
              .contentFrame()
              .frameLocator("iframe");
            await report.getByRole("heading", { name: "Dictation flow" }).waitFor();
            expect(await gateway.getRequests("workboard.cards.screenshots.locate")).toMatchObject([
              { params: { id: CARD_ID, paths: [ON_BASE, OWN, MISSING] } },
            ]);
            const shots = panel.locator(".workboard-flows__screenshots li");
            expect(await shots.allTextContents()).toEqual([
              "dictation-ipad-B.png · default branch",
              "own.png · this card",
              "gone.png · missing",
            ]);
            expect(await shots.nth(2).locator("a").count()).toBe(0);
            const onBase = shots.nth(0).locator("a");
            expect(await onBase.getAttribute("target")).toBe("_blank");
            const onBaseHref = await onBase.getAttribute("href");
            expect(popoutParams(onBaseHref)).toMatchObject({
              id: "screenshot",
              "p.card": CARD_ID,
              "p.source": "base",
              "p.path": ON_BASE,
            });
            await capture(page, "after-flows-tab.png");

            // A click inside the sandboxed report opens the screenshot's own page in a new window.
            const [popup] = await Promise.all([
              page.waitForEvent("popup"),
              report.getByRole("link", { name: "Dictation on iPad" }).click(),
            ]);
            expect(popoutParams(popup.url())).toMatchObject({
              id: "screenshot",
              "p.card": CARD_ID,
              "p.source": "base",
              "p.path": ON_BASE,
            });
            await popup.close();
            const note = panel.locator(".workboard-flows__note");
            await report.getByRole("link", { name: "Summary screen" }).click();
            await note.filter({ hasText: `${MISSING} is not in this card's rounds` }).waitFor();
            await report.getByRole("link", { name: "Onboarding checklist" }).click();
            await note
              .filter({ hasText: "Not opened: ../prototypes/ONB-4/checklist.html." })
              .waitFor();
            await capture(page, "after-flows-link-ignored.png");

            await page.locator("#workboard-detail-tab-screenshots").click();
            const shot = page.locator(
              "#workboard-detail-panel-screenshots .workboard-screenshot a",
            );
            await shot.locator("img").waitFor();
            await expect
              .poll(() =>
                shot.locator("img").evaluate((element: HTMLImageElement) => element.naturalWidth),
              )
              .toBe(640);
            const shotHref = await shot.getAttribute("href");
            expect(popoutParams(shotHref)).toMatchObject({
              id: "screenshot",
              "p.card": CARD_ID,
              "p.source": "0",
              "p.path": OWN,
            });
            await capture(page, "after-screenshots-tab.png");

            // A fresh document carries no opener state, as a copied link on another device.
            await page.goto(new URL(onBaseHref!, suite.server.baseUrl).href);
            const image = page.locator(".workboard-screenshot-page__image");
            await image.waitFor();
            expect(
              await image.evaluate((element: HTMLImageElement) => [
                element.naturalWidth,
                element.clientWidth,
              ]),
            ).toEqual([640, 640]);
            expect(
              (await gateway.getRequests("workboard.cards.screenshots.get")).at(-1),
            ).toMatchObject({ params: { id: CARD_ID, base: true, path: ON_BASE } });
            await capture(page, "after-screenshot-popout.png");
          },
        );
      },
      close: async () => {
        if (sandbox) {
          sandbox.closeAllConnections();
          await new Promise<void>((resolve, reject) => {
            sandbox!.close((error) => (error ? reject(error) : resolve()));
          });
        }
      },
    });
  });
});
