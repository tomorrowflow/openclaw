import { beforeEach, describe, expect, it } from "vitest";
import { signalPlugin } from "../../extensions/signal/src/channel.js";
import type { OpenClawConfig } from "../config/config.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { resolveCommandAuthorization } from "./command-auth.js";
import type { MsgContext } from "./templating.js";

const OWNER = "+15550001111";

function authorize(sender: string, ownerAllowFrom: string[]) {
  const cfg = { channels: { signal: {} }, commands: { ownerAllowFrom } } as OpenClawConfig;
  const ctx = {
    Provider: "signal",
    Surface: "signal",
    From: `signal:${sender}`,
    SenderId: sender,
  } as MsgContext;
  return resolveCommandAuthorization({ ctx, cfg, commandAuthorized: true });
}

describe("Signal owner authorization", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "signal", plugin: signalPlugin, source: "test" }]),
    );
  });

  it("recognizes the prefixed number in the global owner list", () => {
    expect(authorize(OWNER, [`signal:${OWNER}`]).senderIsOwner).toBe(true);
  });

  it("normalizes a formatted number through the Signal plugin", () => {
    expect(authorize(OWNER, ["signal:+1 (555) 000-1111"]).senderIsOwner).toBe(true);
  });

  it("denies another number", () => {
    expect(authorize("+15550002222", [`signal:${OWNER}`]).senderIsOwner).toBe(false);
  });

  it("does not treat a wildcard as ownership", () => {
    expect(authorize("+15550002222", ["*"]).senderIsOwner).toBe(false);
  });
});
