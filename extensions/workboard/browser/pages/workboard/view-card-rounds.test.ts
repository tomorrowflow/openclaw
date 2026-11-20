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

it("shows review times with their round's sessions and the event log in Details, not Activity", () => {
  const { state, container, renderView } = createWorkboardView();
  state.cards = [
    createWorkboardCard({
      status: "review",
      metadata: {
        automation: {
          target: {
            kind: "node-claude",
            nodeId: "mac-factory",
            repoPath: "/repos/app",
            worktreesRoot: "/worktrees",
            hostRepoPath: "/host/app",
          },
        },
      },
      sessions: [{ role: "implementer", round: 1, state: "finished", sessionKey: "agent:dev:a" }],
      reviewTimes: [
        { round: 0, importedAt: 0, verification: { startedAt: 0, endedAt: 190_000 } },
        {
          round: 1,
          importedAt: 300_000,
          verification: { startedAt: 300_000, endedAt: 360_000 },
          verdictAt: 420_000,
        },
      ],
      events: [
        { id: "e1", kind: "created", at: 1 },
        { id: "e2", kind: "comment_added", at: 2 },
      ],
    }),
  ];
  state.detailCardId = "card-1";
  state.detailTab = "activity";
  renderView();
  const activity = container.querySelector("#workboard-detail-panel-activity")!;
  expect(activity.querySelector(".workboard-review-times")).toBeNull();
  expect(activity.querySelector(".workboard-detail__events")).toBeNull();

  state.detailTab = "details";
  renderView();
  const details = container.querySelector("#workboard-detail-panel-details")!;
  const text = (element: Element) => element.textContent?.replace(/\s+/g, " ").trim();
  const rounds = [...details.querySelectorAll(".workboard-detail__sessions details")];
  expect(rounds.map((round) => text(round.querySelector("summary")!))).toEqual([
    "Rework round 1",
    "First run",
  ]);
  expect([...rounds[0]!.querySelectorAll(".workboard-review-times li")].map(text)).toEqual([
    "Verification took 1m",
    "Agent verdict 1m after the verification",
  ]);
  expect([...rounds[1]!.querySelectorAll(".workboard-review-times li")].map(text)).toEqual([
    "Verification took 3m 10s",
  ]);
  expect(rounds[1]!.querySelectorAll(".workboard-detail__session-list li")).toHaveLength(0);
  expect([...details.querySelectorAll(".workboard-detail__events li span")].map(text)).toEqual([
    "Comment added",
    "Created",
  ]);
});
