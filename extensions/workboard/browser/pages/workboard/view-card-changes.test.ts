import "../../test/dom.setup.ts";
import { createHash } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, onTestFinished, vi } from "vitest";
import { normalizeCardsPayload } from "../../lib/workboard/normalization.ts";
import { getWorkboardState } from "../../lib/workboard/runtime.ts";
import {
  createWorkboardCard,
  createWorkboardTestClient,
} from "../../lib/workboard/test/index-helpers.ts";
import { workboardTestHost } from "../../test/host.setup.ts";
import { waitForFast } from "../../test/wait-for.ts";
import { createCardChanges } from "./view-card-changes.tsx";
import { createWorkboardRenderProps, renderInto } from "./view.test-support.ts";

const text = (element: Element | null | undefined) =>
  element?.textContent?.replace(/\s+/g, " ").trim();

it("lists each round's files in a Changes tab, opens a file's diff, and links published rounds to GitHub", async () => {
  const [base, first, rework] = ["a", "b", "c"].map((char) => char.repeat(40));
  const [card] = normalizeCardsPayload({
    cards: [
      {
        ...createWorkboardCard({ status: "review" }),
        pullRequestUrl: "https://github.com/acme/app/pull/96",
        publishedRound: 0,
        rounds: [
          {
            round: 0,
            decisions: [{ phase: "plan", decision: "Return [] for empty input" }],
            changes: {
              from: base,
              to: first,
              files: [{ path: "parser.py", added: 12, deleted: 3 }],
              totals: { files: 1, added: 12, deleted: 3 },
            },
          },
          {
            round: 1,
            changes: {
              from: first,
              to: rework,
              files: [
                { path: "flags.py", added: 4, deleted: 4 },
                { path: "assets/logo.png", binary: true },
                { path: "src/new.ts", previousPath: "src/old.ts", added: 1, deleted: 0 },
              ],
              totals: { files: 5, added: 5, deleted: 4 },
            },
          },
        ],
      },
    ],
  }).cards;
  const listed = expectDefined(card, "card");
  const client = createWorkboardTestClient({
    "workboard.cards.changes.diff": {
      diff: "diff --git a/flags.py b/flags.py\n@@ -1 +1 @@\n-loose = True\n+strict = True",
      truncated: false,
    },
  });
  const host = {};
  const state = getWorkboardState(host);
  state.loaded = true;
  state.cards = [listed];
  state.detailCardId = listed.id;
  state.detailTab = "changes";
  const container = document.createElement("div");
  document.body.append(container);
  onTestFinished(() => container.remove());
  workboardTestHost().connection.connected = true;
  const renderPanel = () =>
    renderInto(
      container,
      createWorkboardRenderProps(host, {
        client,
        canWrite: true,
        onOpenSession: vi.fn(),
        detailChanges: changes,
      }),
    );
  const changes = createCardChanges(client, () => renderPanel());
  renderPanel();

  expect(text(container.querySelector("#workboard-detail-tab-changes"))).toBe("Changes");
  const panel = expectDefined(
    container.querySelector("#workboard-detail-panel-changes"),
    "changes panel",
  );
  const rounds = [...panel.querySelectorAll(".workboard-round")];
  expect(rounds.map((round) => text(round.querySelector("h3")))).toEqual([
    "Rework round 1 5 files, +5 −4",
    "First run 1 files, +12 −3 View on GitHub",
  ]);
  const [reworkRound, firstRound] = rounds;
  expect(
    [...(reworkRound?.querySelectorAll(".workboard-round__files summary") ?? [])].map(text),
  ).toEqual(["flags.py +4 −4", "assets/logo.png binary", "src/new.ts +1 −0 from src/old.ts"]);
  expect(text(reworkRound?.querySelector(".workboard-round__more"))).toBe(
    "2 more files not listed",
  );
  // Round 1 is not on the PR branch yet, so it has no GitHub links.
  expect(reworkRound?.querySelector("a")).toBeNull();

  const compare = `https://github.com/acme/app/compare/${base}...${first}`;
  expect(firstRound?.querySelector<HTMLAnchorElement>(".workboard-change__compare")?.href).toBe(
    compare,
  );
  const anchor = createHash("sha256").update("parser.py").digest("hex");
  await waitForFast(() =>
    expect(firstRound?.querySelector<HTMLAnchorElement>(".workboard-change__github")?.href).toBe(
      `${compare}#diff-${anchor}`,
    ),
  );

  const flags = expectDefined(
    reworkRound?.querySelector<HTMLDetailsElement>("details.workboard-change"),
    "flags.py row",
  );
  flags.open = true;
  flags.dispatchEvent(new Event("toggle"));
  await waitForFast(() =>
    expect(client.request).toHaveBeenCalledWith("workboard.cards.changes.diff", {
      id: listed.id,
      round: 1,
      path: "flags.py",
    }),
  );
  await waitForFast(() => {
    const lines = [...flags.querySelectorAll(".workboard-change__diff > span")];
    expect(lines.map((line) => [line.className, line.textContent?.trimEnd()])).toEqual([
      ["", "diff --git a/flags.py b/flags.py"],
      ["workboard-change__hunk", "@@ -1 +1 @@"],
      ["workboard-change__deleted", "-loose = True"],
      ["workboard-change__added", "+strict = True"],
    ]);
  });
});
