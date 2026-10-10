import "../../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import type { WorkboardTrustResult } from "@openclaw/workboard-contract";
import { describe, expect, it, vi } from "vitest";
import { mountPage } from "./workboard-page.test-support.ts";

const TARGET = {
  kind: "node-claude" as const,
  nodeId: "mac-factory",
  repoPath: "/repo",
  worktreesRoot: "/worktrees",
  hostRepoPath: "/host/repo",
};

function trustResult(accepted: number, autonomous: number): WorkboardTrustResult {
  const counts = {
    tickets: 3,
    accepted,
    cleanAccepted: autonomous,
    firstPass: 2,
    blocked: 1,
    reworkRounds: 1,
    outsideCommits: 1,
    questionRounds: 0,
    operatorAnswers: 0,
    attempts: 4,
    verdictRounds: 0,
    verdictAgreedRounds: 0,
    verdictCards: 0,
    verdictAgreedCards: 0,
    verdictMissed: 0,
  };
  return {
    boardId: "app",
    generatedAt: 1,
    total: counts,
    classes: [{ taskClass: "dead-code", ...counts }],
    weeks: [{ weekStart: Date.UTC(2026, 9, 5), accepted, autonomous, medianLeadTimeMs: 3_600_000 }],
  };
}

function mountTrust(board: Record<string, unknown>, loadTrust: () => WorkboardTrustResult) {
  const page = mountPage({ boardId: "app" });
  const request = expectDefined(page.request.getMockImplementation(), "request implementation");
  let updatedAt = 1;
  page.request.mockImplementation(async (method, params) => {
    if (method === "workboard.cards.list") {
      return {
        cards: [],
        boards: [
          { id: "app", total: 3, active: 3, archived: 0, byStatus: {}, updatedAt, ...board },
        ],
      };
    }
    return method === "workboard.cards.trust" ? loadTrust() : request(method, params);
  });
  page.fixture.connection.connected = true;
  page.fixture.notify();
  return {
    ...page,
    trigger: () =>
      page.container.querySelector<HTMLButtonElement>(".workboard-heading__trust-trigger"),
    bumpRevision() {
      updatedAt += 1;
    },
  };
}

describe("Workboard trust KPIs", () => {
  it("stays hidden on boards without a node target", async () => {
    const loadTrust = vi.fn(() => trustResult(1, 1));
    const page = mountTrust({}, loadTrust);
    await vi.waitFor(() => expect(page.workboard.state.loaded).toBe(true));
    expect(page.trigger()).toBeNull();
    expect(loadTrust).not.toHaveBeenCalled();
  });

  it("shows on a board that sends cards to a node only through label routes", async () => {
    const page = mountTrust(
      { orchestration: { targetRoutes: [{ labels: ["class:server-fix"], target: TARGET }] } },
      () => trustResult(2, 1),
    );

    await vi.waitFor(() =>
      expect(page.trigger()?.textContent).toContain("1 of 2 autonomous this week"),
    );
  });

  it("shows this week's autonomy on a project board and reloads on board changes", async () => {
    let result = trustResult(2, 1);
    const page = mountTrust({ orchestration: { defaultTarget: TARGET } }, () => result);

    await vi.waitFor(() =>
      expect(page.trigger()?.textContent).toContain("1 of 2 autonomous this week"),
    );
    const popover = expectDefined(
      page.container.querySelector("#workboard-trust-popover"),
      "trust popover",
    );
    expect(popover.textContent).toContain("dead-code");
    expect(popover.textContent).toContain("50%");
    expect(page.request).toHaveBeenCalledWith("workboard.cards.trust", { boardId: "app" });

    result = trustResult(3, 3);
    page.bumpRevision();
    page.fixture.emit("plugin.workboard.changed", { epoch: "cards", revision: 2 });
    await vi.waitFor(() =>
      expect(page.trigger()?.textContent).toContain("3 of 3 autonomous this week"),
    );
  });
});
