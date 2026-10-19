import "../../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { normalizeCardsPayload } from "../../lib/workboard/normalization.ts";
import {
  createWorkboardCard,
  createWorkboardTestClient,
} from "../../lib/workboard/test/index-helpers.ts";
import { createWorkboardView } from "./view.test-support.ts";

it("shows each round's decisions in the activity tab, newest round first, without its files", () => {
  const changes = (path: string, added: number, deleted: number) => ({
    from: "a".repeat(40),
    to: "b".repeat(40),
    files: [
      { path, added, deleted },
      { path: "assets/logo.png", binary: true },
      { path: "src/new.ts", previousPath: "src/old.ts", added: 1, deleted: 0 },
      { path: 42 },
    ],
    totals: { files: 4, added: added + 1, deleted },
  });
  const [card] = normalizeCardsPayload({
    cards: [
      {
        ...createWorkboardCard({ status: "review" }),
        rounds: [
          {
            round: 0,
            decisions: [{ phase: "plan", decision: "Return [] for empty input" }],
            changes: changes("parser.py", 12, 3),
          },
          {
            round: 1,
            decisions: [
              {
                ts: "10:02",
                phase: "fix",
                decision: "Rename the flag to --strict",
                why: "review asked for it",
                evidence: "flags.py:1",
                result: "done",
              },
              { phase: "verify" },
            ],
            changes: changes("flags.py", 4, 4),
          },
          { round: "two", decisions: [] },
        ],
      },
    ],
  }).cards;
  const listed = expectDefined(card, "card");
  const { state, container, renderView } = createWorkboardView({
    client: createWorkboardTestClient({}),
    connected: true,
    canWrite: true,
  });
  state.cards = [listed];
  state.detailCardId = listed.id;
  state.detailTab = "activity";
  renderView();

  const text = (element: Element | null | undefined) =>
    element?.textContent?.replace(/\s+/g, " ").trim();
  const rounds = [...container.querySelectorAll(".workboard-round")];
  expect(rounds.map((round) => text(round.querySelector("h3")))).toEqual([
    "Rework round 1",
    "First run",
  ]);
  const [rework] = rounds;
  expect(container.querySelector(".workboard-round__files")).toBeNull();
  expect([...(rework?.querySelectorAll(".workboard-round__decisions li") ?? [])].map(text)).toEqual(
    ["fix Rename the flag to --strict review asked for it flags.py:1 done 10:02"],
  );
  expect(text(rework?.querySelector(".workboard-round__decisions code"))).toBe("flags.py:1");
});
