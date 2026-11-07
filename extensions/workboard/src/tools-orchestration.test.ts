import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";
import { createWorkboardTools } from "./tools.js";
import { readPayload } from "./tools.test-support.js";

describe("workboard_stats tool", () => {
  it("returns the overview and merge digest from workboard_stats on request", async () => {
    const store = createWorkboardSqliteTestStore();
    const tools = new Map(createWorkboardTools({ store }).map((tool) => [tool.name, tool]));
    const stats = expectDefined(tools.get("workboard_stats"), "workboard_stats tool");
    await store.create({ title: "Stats card", status: "todo" });

    const plain = readPayload(await stats.execute("stats-plain", {}));
    expect(plain).toMatchObject({ id: "all", total: 1 });
    expect(plain).not.toHaveProperty("overview");
    expect(plain).not.toHaveProperty("mergeDigest");

    const since = Date.now() - 60_000;
    const extended = readPayload(
      await stats.execute("stats-extended", { overview: true, mergeDigest: true, since }),
    );
    expect(extended).toMatchObject({
      id: "all",
      total: 1,
      overview: { boardId: "all", needsYou: [], inFlight: [], shipped: [] },
      mergeDigest: { boardId: "all", since, classes: [] },
    });
  });
});
