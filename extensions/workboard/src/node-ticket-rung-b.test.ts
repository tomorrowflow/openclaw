// Workboard tests cover the trust ladder's rung b: class rungs, agent acceptance, and the review sample.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import type {
  WorkboardCard,
  WorkboardClassRung,
  WorkboardExecutionTarget,
} from "@openclaw/workboard-contract";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import { registerWorkboardGatewayMethods } from "./gateway.js";
import { publishCandidate, publishNodeTicket } from "./node-ticket-publish.js";
import { nodeTicketAcceptance, nodeTicketTarget } from "./node-ticket.js";
import {
  createFakeGitHub,
  createNodeRepos,
  git,
  NODE_TARGET,
  startNodeCard,
} from "./node-ticket.test-support.js";
import type { WorkboardStore } from "./store.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";
import { createWorkboardTools } from "./tools.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const VERDICT_FIRST = "Post `Verdict: accept` or `Verdict: rework: <finding>` as a comment first";

/**
 * A docs ticket launched under `classRungs` and imported as the bundle import
 * leaves it: handoff `imported`, claim released, waiting in review. `later`
 * replaces the board's rungs after the launch.
 */
async function importedDocsTicket(
  store: WorkboardStore,
  params: {
    classRungs?: Record<string, WorkboardClassRung>;
    later?: Record<string, WorkboardClassRung>;
    target?: WorkboardExecutionTarget;
    headCommit?: string;
  } = {},
) {
  if (params.classRungs) {
    await store.upsertBoard({ id: "default", orchestration: { classRungs: params.classRungs } });
  }
  const { card } = await startNodeCard(store, undefined, params.target, ["class:docs"]);
  const running = expectDefined(await store.get(card.id), "running card");
  const claim = expectDefined(running.metadata?.claim, "claim");
  const worktree = expectDefined(nodeTicketTarget(running)?.worktree, "worktree");
  await store.setNodeHandoff(
    card.id,
    {
      worktreePath: worktree.path,
      handoff: {
        phase: "imported",
        headCommit: params.headCommit ?? "b".repeat(40),
        importedAt: Date.now(),
      },
    },
    claim,
  );
  await store.releaseClaim(card.id, {
    ownerId: claim.ownerId,
    token: claim.token,
    status: "review",
  });
  if (params.later) {
    await store.upsertBoard({ id: "default", orchestration: { classRungs: params.later } });
  }
  return card;
}

function agentTools(store: WorkboardStore) {
  const tools = createWorkboardTools({ store, context: { agentId: "dev" } });
  return (name: string) =>
    expectDefined(
      tools.find((tool) => tool.name === name),
      name,
    );
}

const handoffOf = async (store: WorkboardStore, card: WorkboardCard) =>
  nodeTicketTarget(expectDefined(await store.get(card.id), "card"))?.worktree?.handoff;

function readPayload(result: unknown): Record<string, unknown> {
  return (result as { details?: Record<string, unknown> }).details ?? {};
}

describe("Workboard rung b", () => {
  it("keeps operator-set class rungs whole: replaced, cleared, refused when invalid, never agent-set", async () => {
    const store = createWorkboardSqliteTestStore();
    const rungs = async () =>
      (await store.listBoards()).boards.find((board) => board.id === "app")?.orchestration
        ?.classRungs;
    await store.upsertBoard({
      id: "app",
      orchestration: {
        classRungs: { docs: { rung: "b" }, security: { rung: "b", sampleEvery: 1 } },
      },
    });
    const boardCreate = expectDefined(
      createWorkboardTools({ store, context: { agentId: "dev" } }).find(
        (tool) => tool.name === "workboard_board_create",
      ),
      "board create tool",
    );
    expect(
      Value.Check(boardCreate.parameters, {
        id: "app",
        orchestration: { classRungs: { docs: { rung: "b" } } },
      }),
    ).toBe(false);
    await boardCreate.execute("call-board", { id: "app", orchestration: { autoDecompose: true } });
    await expect(rungs()).resolves.toEqual({
      docs: { rung: "b" },
      security: { rung: "b", sampleEvery: 1 },
    });

    await store.upsertBoard({ id: "app", orchestration: { classRungs: { docs: { rung: "a" } } } });
    await expect(rungs()).resolves.toEqual({ docs: { rung: "a" } });
    for (const [classRungs, error] of [
      [{ docs: { rung: "c" } }, "class rung docs needs rung a or b."],
      [
        { docs: { rung: "b", sampleEvery: 0 } },
        "class rung docs sampleEvery must be an integer from 1 to 100.",
      ],
      [
        { docs: { rung: "b", sampleEvery: 1.5 } },
        "class rung docs sampleEvery must be an integer from 1 to 100.",
      ],
      [
        { "class:docs": { rung: "b" } },
        "class rung class:docs must name the class without the class: prefix.",
      ],
      [
        { " docs": { rung: "b" } },
        "class rung names must be 1 to 34 characters without surrounding spaces.",
      ],
      [[{ rung: "b" }], "class rungs must be an object of at most 50 classes."],
      [
        Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`c${index}`, { rung: "b" }])),
        "class rungs must be an object of at most 50 classes.",
      ],
    ] as const) {
      await expect(store.upsertBoard({ id: "app", orchestration: { classRungs } })).rejects.toThrow(
        error,
      );
    }
    await expect(rungs()).resolves.toEqual({ docs: { rung: "a" } });
    await store.upsertBoard({ id: "app", orchestration: { classRungs: null } });
    await expect(rungs()).resolves.toBeUndefined();
  });

  it("refuses an agent's acceptance at rung a through every tool that reaches done", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await importedDocsTicket(store);
    await store.addComment(card.id, { body: "Verdict: accept" }, undefined, "agent:dev");
    const tool = agentTools(store);
    const refusal = "Rung a: the operator accepts docs tickets.";

    await expect(
      tool("workboard_move").execute("move", { id: card.id, status: "done" }),
    ).rejects.toThrow(refusal);
    await expect(
      tool("workboard_release").execute("release", { id: card.id, status: "done" }),
    ).rejects.toThrow(refusal);
    const claimed = readPayload(await tool("workboard_claim").execute("claim", { id: card.id }));
    await expect(
      tool("workboard_complete").execute("complete", {
        id: card.id,
        token: claimed.token,
        summary: "Looks right",
      }),
    ).rejects.toThrow(refusal);

    expect((await store.get(card.id))?.status).not.toBe("done");
    await expect(handoffOf(store, card)).resolves.toEqual({
      phase: "imported",
      headCommit: "b".repeat(40),
      importedAt: expect.any(Number),
    });
  });

  it("refuses an agent's acceptance of a round that ran before its class reached rung b", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await importedDocsTicket(store, { later: { docs: { rung: "b" } } });
    await store.addComment(card.id, { body: "Verdict: accept" }, undefined, "agent:dev");

    await expect(
      agentTools(store)("workboard_move").execute("move", { id: card.id, status: "done" }),
    ).rejects.toThrow(
      "This round ran before its class reached rung b, so the operator accepts it.",
    );
  });

  it("lets an agent accept at rung b after its verdict, and an operator retry decides again", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await importedDocsTicket(store, {
      classRungs: { docs: { rung: "b", sampleEvery: 1 } },
    });
    const move = agentTools(store)("workboard_move");
    await expect(move.execute("early", { id: card.id, status: "done" })).rejects.toThrow(
      VERDICT_FIRST,
    );

    await store.addComment(card.id, { body: "Verdict: accept" }, undefined, "agent:dev");
    await move.execute("accept", { id: card.id, status: "done" });
    expect((await store.get(card.id))?.status).toBe("done");
    await expect(handoffOf(store, card)).resolves.toMatchObject({
      phase: "imported",
      decidedBy: "agent:dev",
      sampled: true,
    });

    // A failed publish blocks the card; the operator's move to done then decides it.
    await store.block(card.id, { reason: "Draft PR failed" }, null);
    const methods = new Map<string, Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1]>();
    registerWorkboardGatewayMethods({
      api: {
        runtime: {},
        registerGatewayMethod: (
          method: string,
          handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1],
        ) => methods.set(method, handler),
      } as unknown as OpenClawPluginApi,
      store,
    });
    const respond = vi.fn();
    await expectDefined(
      methods.get("workboard.cards.move"),
      "move method",
    )({
      params: { id: card.id, status: "done" },
      respond,
    } as never);
    expect(respond).toHaveBeenCalledWith(true, expect.anything());
    await expect(handoffOf(store, card)).resolves.toEqual({
      phase: "imported",
      headCommit: "b".repeat(40),
      importedAt: expect.any(Number),
    });
  });

  it("samples by the card: stable per card, every reworked round, and 1 in sampleEvery", () => {
    const accept = (id: string, classRung: WorkboardClassRung, round = 0) =>
      nodeTicketAcceptance({
        card: {
          id,
          title: id,
          status: "done",
          priority: "normal",
          labels: ["class:docs"],
          position: 0,
          createdAt: 0,
          updatedAt: 0,
          metadata: {
            comments: [{ id: "v", body: "Verdict: accept", createdAt: 1, source: "agent:dev" }],
          },
        },
        worktree: {
          path: "/wt",
          branch: `factory/${id}`,
          baseCommit: "a",
          rung: "b",
          ...(round > 0
            ? { rework: { round, pullRequestUrl: "u", acceptedAt: 0, outsideCommits: 0 } }
            : {}),
        },
        handoff: { phase: "imported", headCommit: "b", importedAt: 0 },
        actor: "agent:dev",
        classRung,
      }).sampled;
    const ids = Array.from({ length: 300 }, (_, index) => `card-${index}`);
    const picks = ids.map((id) => accept(id, { rung: "b" }));

    expect(ids.map((id) => accept(id, { rung: "b" }))).toEqual(picks);
    const sampled = picks.filter(Boolean).length;
    expect(sampled).toBeGreaterThan(70);
    expect(sampled).toBeLessThan(130);
    const unsampled = expectDefined(ids[picks.indexOf(false)], "an unsampled card");
    expect(accept(unsampled, { rung: "b" }, 1)).toBe(true);
    expect(accept(unsampled, { rung: "b", sampleEvery: 1 })).toBe(true);
  });

  it("opens an agent-accepted PR ready for review with the sample and review lines, an operator's as a draft", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "workboard-rung-b-"));
    roots.push(root);
    const repos = createNodeRepos(root);
    git(repos.hostRepo, "remote", "set-url", "origin", "git@github.com:acme/app.git");
    const github = createFakeGitHub(repos.origin);
    github.tokens.set("acme/app", "token-app");
    const store = createWorkboardSqliteTestStore();
    const publish = async (decide: (card: WorkboardCard) => Promise<unknown>) => {
      const head = git(repos.hostRepo, "rev-parse", "HEAD");
      const card = await importedDocsTicket(store, {
        classRungs: { docs: { rung: "b", sampleEvery: 1 } },
        target: { ...NODE_TARGET, hostRepoPath: repos.hostRepo },
        headCommit: head,
      });
      git(repos.hostRepo, "branch", `factory/${card.id}`, head);
      await store.addProof(card.id, {
        status: "passed",
        label: "standards review",
        note: "2 findings, 2 fixed",
      });
      await store.addComment(card.id, { body: "Verdict: accept" }, undefined, "agent:dev");
      await decide(card);
      const item = expectDefined(
        publishCandidate(expectDefined(await store.get(card.id), "card")),
        "publish candidate",
      );
      await publishNodeTicket({ store, github: github.access, item, now: Date.now });
      return {
        opened: github.requests.findLast((request) => request.method === "POST")?.body as Record<
          string,
          unknown
        >,
        reviews: nodeTicketTarget(expectDefined(await store.get(card.id), "card"))?.worktree
          ?.reviews,
      };
    };

    const agent = await publish(
      async (card) =>
        await agentTools(store)("workboard_move").execute("accept", {
          id: card.id,
          status: "done",
        }),
    );
    expect(agent.opened).toMatchObject({ draft: false });
    expect(agent.opened.body).toContain(
      "Standards review: 2 findings, 2 fixed\n\nSampled for human review: a person reads this PR before it merges.",
    );
    expect(agent.reviews).toEqual([
      expect.objectContaining({ round: 0, verdict: "accept", decidedBy: "agent", sampled: true }),
    ]);

    const operator = await publish(async (card) => await store.move(card.id, "done", undefined));
    expect(operator.opened).toMatchObject({ draft: true });
    expect(operator.opened.body).not.toContain("Sampled");
    expect(operator.reviews).toEqual([
      {
        round: 0,
        verdict: "accept",
        importedAt: expect.any(Number),
        publishedAt: expect.any(Number),
      },
    ]);
    expect((await store.trust({ boardId: "default" })).classes).toEqual([
      expect.objectContaining({ taskClass: "docs", rung: "b", accepted: 2, agentAccepts: 1 }),
    ]);
  });
});
