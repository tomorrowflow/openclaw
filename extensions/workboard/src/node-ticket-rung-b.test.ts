// Workboard tests cover the trust ladder's rung b: the operator's class rungs on a board.
import { expectDefined } from "@openclaw/normalization-core";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";
import { createWorkboardTools } from "./tools.js";

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
});
