import { Value } from "typebox/value";
import { expect, it } from "vitest";
import type { CronStatusSummary } from "../../cron/service/state.js";
import { CronToolOutputSchema } from "./cron-tool-output-schema.js";

it("accepts every field the scheduler reports in cron status", () => {
  // Required<> makes a new CronStatusSummary field fail to compile until the closed schema lists it.
  const status: Required<CronStatusSummary> = {
    enabled: true,
    triggersEnabled: true,
    fallbackWithoutAccount: true,
    storePath: "/synthetic/openclaw.sqlite",
    storage: "sqlite",
    sqlitePath: "/synthetic/openclaw.sqlite",
    jobs: 3,
    nextWakeAtMs: null,
  };
  expect(Value.Check(CronToolOutputSchema, status)).toBe(true);
});
