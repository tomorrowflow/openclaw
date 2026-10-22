// Runs node ticket prototypes under the production app CSP through the real sandbox listener.
import type { Server } from "node:http";
import path from "node:path";
import type { FrameLocator, Page } from "playwright-core";
import { expect, it } from "vitest";
import { buildSandboxHostPath } from "../../../src/agents/sandbox-host.js";
import {
  buildControlUiCspHeader,
  computeInlineScriptHashes,
} from "../../../src/gateway/control-ui-csp.js";
import { createSandboxHostHttpServer } from "../../../src/gateway/mcp-app-sandbox-http.js";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { workboardUi } from "../test-helpers/control-ui-workboard-fixture.ts";
import {
  workboardPrototypeCard,
  workboardPrototypeResponses,
} from "../test-helpers/control-ui-workboard-prototype-fixture.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Workboard prototype preview",
  startServerBeforeBrowser: true,
});

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

/** Every Control UI document gets the policy the Gateway serves, so inline scripts need the sandbox. */
async function serveAppCsp(page: Page) {
  await page.route(`${suite.server.baseUrl}**`, async (route) => {
    if (route.request().resourceType() !== "document" || route.request().frame().parentFrame()) {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    const body = await response.text();
    await route.fulfill({
      response,
      body,
      headers: {
        ...response.headers(),
        "Content-Security-Policy": buildControlUiCspHeader({
          inlineScriptHashes: computeInlineScriptHashes(body),
        }),
      },
    });
  });
}

/** The prototype document inside the host preview's sandbox shell. */
function prototypeDocument(page: Page, scope: string): FrameLocator {
  return page
    .locator(`${scope} iframe.chat-html-preview__frame`)
    .contentFrame()
    .frameLocator("iframe");
}

async function capture(page: Page, name: string) {
  if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
    await page.screenshot({ path: path.join(suite.artifactDir, name), animations: "disabled" });
  }
}

suite.define(() => {
  it("runs prototype scripts in the drawer tab and in the pop-out page", async (test) => {
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
            const responses = workboardPrototypeResponses(now);
            const board = {
              id: "card-states",
              name: "Card states",
              total: 1,
              active: 1,
              archived: 0,
              byStatus: { running: 1 },
            };
            const card = {
              id: "state-prototype",
              title: "Prototype the onboarding checklist",
              status: "running",
              priority: "normal",
              labels: [],
              position: 1,
              createdAt: now - 3_600_000,
              updatedAt: now - 60_000,
              agentId: "main",
              ...workboardPrototypeCard,
            };
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
                  statuses: ["todo", "running", "done"],
                },
                ...responses,
                "canvas.document.preview": {
                  html: responses["workboard.cards.prototypes.get"].html,
                  sandboxUrl: buildSandboxHostPath({ blockDescendantFrames: true }),
                  sandboxPort,
                  sandboxOrigin: `http://127.0.0.1:${sandboxPort}`,
                },
              },
            });
            await serveAppCsp(page);

            await page.goto(`${suite.server.baseUrl}workboard/card-states`);
            await page.getByText("Prototype the onboarding checklist").first().click();
            await page.locator("#workboard-detail-tab-prototype").click();
            const tab = prototypeDocument(page, "#workboard-detail-panel-prototype");
            // The prototype's own script marks the first step on load.
            await tab.getByText("1 of 3 done").waitFor();
            await tab.getByRole("button", { name: "Invite a teammate" }).click();
            await tab.getByText("2 of 3 done").waitFor();
            await capture(page, "after-tab.png");
            expect(await gateway.getRequests("canvas.document.preview")).toMatchObject([
              { params: { html: responses["workboard.cards.prototypes.get"].html } },
            ]);

            const link = page.getByRole("link", { name: "Open in new window" });
            expect(await link.getAttribute("target")).toBe("_blank");
            expect(await link.getAttribute("rel")).toBe("noopener");
            const href = new URL((await link.getAttribute("href"))!, suite.server.baseUrl);
            expect(Object.fromEntries(href.searchParams)).toMatchObject({
              "p.card": "state-prototype",
              "p.source": "live",
              "p.path": "docs/prototypes/ONB-4/checklist-v2.html",
            });

            // A fresh document carries no opener state, as on another device.
            await page.goto(href.toString());
            const popout = prototypeDocument(page, ".workboard-prototype-page");
            await popout.getByText("1 of 3 done").waitFor();
            await popout.getByRole("button", { name: "Create your first board" }).click();
            await popout.getByText("2 of 3 done").waitFor();
            await capture(page, "after-popout.png");
            expect(
              (await gateway.getRequests("workboard.cards.prototypes.get")).at(-1),
            ).toMatchObject({
              params: {
                id: "state-prototype",
                live: true,
                path: "docs/prototypes/ONB-4/checklist-v2.html",
              },
            });

            href.searchParams.delete("p.path");
            await page.goto(href.toString());
            await page
              .locator(".workboard-prototype-page [role=alert]")
              .filter({ hasText: "This prototype link needs a card" })
              .waitFor();
            await capture(page, "after-popout-invalid.png");
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
