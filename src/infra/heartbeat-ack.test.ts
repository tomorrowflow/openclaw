import { describe, expect, it } from "vitest";
import { isHeartbeatAckByTrailingSilent } from "./heartbeat-compat.js";

describe("isHeartbeatAckByTrailingSilent", () => {
  it.each([
    ["short prose then token", "Nothing new.\nNO_REPLY", true],
    ["token after markdown emphasis", "Nothing new. **NO_REPLY", true],
    ["heartbeat ok then token", "HEARTBEAT_OK\nNO_REPLY", true],
    ["exact token is already silent upstream", "NO_REPLY", false],
    ["token glued to a word is prose", "Nothing newNO_REPLY", false],
    ["no token", "Nothing new.", false],
    ["token not at the tail", "NO_REPLY then more news", false],
    ["prose over 300 chars", `${"x".repeat(301)}\nNO_REPLY`, false],
  ])("%s", (_name, text, expected) => {
    expect(isHeartbeatAckByTrailingSilent(text)).toBe(expected);
  });
});
