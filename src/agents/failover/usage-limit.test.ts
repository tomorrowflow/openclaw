import { describe, expect, it } from "vitest";
import { parseProviderUsageLimit } from "./usage-limit.js";

// 22:50 in Berlin (CET, UTC+1).
const NOW = Date.parse("2026-11-25T21:50:00Z");

describe("parseProviderUsageLimit", () => {
  it.each([
    ["You've hit your session limit · resets 11:10pm (Europe/Berlin)", "2026-11-25T22:10:00Z"],
    ["You've hit your session limit · resets 23:10 (Europe/Berlin)", "2026-11-25T22:10:00Z"],
    // Already past today in Berlin, so tomorrow's.
    ["You've hit your session limit · resets 2:20am (Europe/Berlin)", "2026-11-26T01:20:00Z"],
    ["You've hit your session limit · resets 10pm (America/New_York)", "2026-11-26T03:00:00Z"],
    ["You've hit your weekly limit · resets Dec 1, 9am (Europe/Berlin)", "2026-12-01T08:00:00Z"],
  ])("reads the reset of %s", (message, resetsAt) => {
    expect(parseProviderUsageLimit(message, NOW)).toEqual({ resetsAt: Date.parse(resetsAt) });
  });

  it.each([
    "429 Too Many Requests",
    "You've hit your session limit · resets 5pm (Mars/Olympus)",
    "You've hit your session limit · resets 13pm (Europe/Berlin)",
  ])("reports a limit without a readable reset for %s", (message) => {
    expect(parseProviderUsageLimit(message, NOW)).toEqual({});
  });

  it.each(["CLI failed.", "Your credit balance is too low to access the Anthropic API."])(
    "leaves other errors alone: %s",
    (message) => {
      expect(parseProviderUsageLimit(message, NOW)).toBeUndefined();
    },
  );
});
