import { describe, expect, it } from "vitest";
import { restartResumeSkipReason } from "./session-run-lifecycle-projection.js";
import type { InternalSessionEntry } from "./types.js";

const entry = (fields: Partial<InternalSessionEntry> = {}) =>
  ({ sessionId: "s1", updatedAt: 1, ...fields }) as InternalSessionEntry;

describe("restartResumeSkipReason", () => {
  it("resumes interrupted conversation sessions", () => {
    expect(restartResumeSkipReason("agent:main:main", entry())).toBeUndefined();
    expect(restartResumeSkipReason("agent:main:signal:direct:+1", entry())).toBeUndefined();
  });

  it("never resumes isolated heartbeat executions", () => {
    expect(restartResumeSkipReason("agent:frodi:main:heartbeat")).toBe("heartbeat");
    expect(
      restartResumeSkipReason(
        "agent:frodi:custom-poll",
        entry({ heartbeatIsolatedBaseSessionKey: "agent:frodi:main" }),
      ),
    ).toBe("heartbeat");
  });
});
