import "../../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import { nothing, render } from "lit";
import { expect, it, onTestFinished, vi } from "vitest";
import { normalizeCardsPayload } from "../../lib/workboard/normalization.ts";
import { getWorkboardState } from "../../lib/workboard/runtime.ts";
import {
  createWorkboardCard,
  createWorkboardTestClient,
} from "../../lib/workboard/test/index-helpers.ts";
import { workboardTestHost } from "../../test/host.setup.ts";
import { renderCardDetailsPanel } from "./view-card-details.ts";

it("shows each round's changed files and decisions in the activity tab, newest round first", () => {
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
  const host = {};
  const state = getWorkboardState(host);
  state.loaded = true;
  state.cards = [listed];
  state.detailCardId = listed.id;
  state.detailTab = "activity";
  const container = document.createElement("div");
  document.body.append(container);
  onTestFinished(() => {
    render(nothing, container);
    container.remove();
  });
  workboardTestHost().connection.connected = true;
  render(
    renderCardDetailsPanel({
      host,
      client: createWorkboardTestClient({}),
      connected: true,
      canWrite: true,
      agentsList: null,
      sessions: [],
      onOpenSession: vi.fn(),
    }),
    container,
  );

  const text = (element: Element | null | undefined) =>
    element?.textContent?.replace(/\s+/g, " ").trim();
  const rounds = [...container.querySelectorAll(".workboard-round")];
  expect(rounds.map((round) => text(round.querySelector("h3")))).toEqual([
    "Rework round 1",
    "First run",
  ]);
  const [rework] = rounds;
  expect(text(rework?.querySelector(".workboard-round__totals"))).toBe("4 files, +5 −4");
  expect([...(rework?.querySelectorAll(".workboard-round__files li") ?? [])].map(text)).toEqual([
    "flags.py +4 −4",
    "assets/logo.png binary",
    "src/new.ts +1 −0 from src/old.ts",
  ]);
  expect([...(rework?.querySelectorAll(".workboard-round__decisions li") ?? [])].map(text)).toEqual(
    ["fix Rename the flag to --strict review asked for it flags.py:1 done 10:02"],
  );
  expect(text(rework?.querySelector(".workboard-round__decisions code"))).toBe("flags.py:1");
});
