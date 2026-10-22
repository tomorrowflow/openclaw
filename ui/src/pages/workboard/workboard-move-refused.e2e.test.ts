import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "../../e2e/control-ui-e2e-suite.test-support.ts";
import { createControlUiE2eArtifactDir } from "../../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../../test-helpers/control-ui-e2e.ts";
import { workboardUi } from "../../test-helpers/control-ui-workboard-fixture.ts";

const suite = createControlUiE2eSuite({ name: "Workboard refused move" });
const baseTime = Date.parse("2026-06-01T18:00:00.000Z");
const reason =
  "This ticket's latest round was imported but isn't published yet. Move the card to done to push it to the draft PR, then move it to todo for rework.";
const config = { plugins: { entries: { workboard: { enabled: true } } } };

function card(id: string, status: string, title: string) {
  return {
    id,
    title,
    labels: [],
    position: 1000,
    priority: "normal",
    status,
    createdAt: baseTime,
    updatedAt: baseTime,
  };
}

const reviewCard = card("review-card", "review", "Imported round awaiting publish");
const todoCard = card("todo-card", "todo", "Queued work");

suite.define(() => {
  it("shows the Gateway's reason when it refuses a card move", async () => {
    const context = await suite.newBrowserContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    try {
      const gateway = await installMockGateway(page, {
        ...workboardUi,
        methodResponses: {
          "config.get": {
            config,
            hash: "workboard-move-refused-e2e",
            path: "/tmp/openclaw-e2e/openclaw.json",
            raw: JSON.stringify(config),
            resolved: config,
            sourceConfig: config,
          },
          "workboard.cards.list": {
            boards: [{ id: "default", total: 2, active: 2, archived: 0, byStatus: {} }],
            cards: [todoCard, reviewCard],
            statuses: ["todo", "review"],
          },
          "workboard.cards.move": { __mockError: { code: "workboard_error", message: reason } },
        },
      });
      await page.goto(`${suite.server.baseUrl}workboard`);
      const column = (status: string) => page.locator(`.workboard-column--${status}`).first();
      const moving = column("review").locator(".workboard-card", { hasText: reviewCard.title });
      await moving.waitFor({ state: "visible" });

      await moving.dragTo(column("todo"));
      await expect
        .poll(async () => (await gateway.getRequests("workboard.cards.move")).length)
        .toBe(1);
      const [move] = await gateway.getRequests("workboard.cards.move");
      expect(move?.params).toMatchObject({ id: reviewCard.id, status: "todo" });

      // The page's own load on the failed move's update must not clear the move's error.
      const alert = page.getByRole("alert").filter({ hasText: "isn't published yet" });
      await alert.waitFor({ state: "visible" });
      await moving.waitFor({ state: "visible" });

      if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
        const directory = createControlUiE2eArtifactDir("workboard-move-refused");
        const image = await takeControlUiViewportScreenshot(page, column("review"), [alert]);
        await writeFile(path.join(directory, "move-refused.png"), image);
        console.log(`[control-ui-e2e] retained proof: ${directory}`);
      }
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
