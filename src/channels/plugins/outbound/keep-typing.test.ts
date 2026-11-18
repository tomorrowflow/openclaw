import { afterEach, describe, expect, it, vi } from "vitest";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../../test-utils/channel-plugins.js";
import type { ChannelPlugin } from "../types.public.js";
import { keepChannelTyping } from "./keep-typing.js";

function registryWithTyping(sendTypingGuarded?: ChannelPlugin["heartbeat"]) {
  const plugin: ChannelPlugin = {
    ...createChannelTestPluginBase({ id: "demo-typing", label: "Demo Typing" }),
    ...(sendTypingGuarded ? { heartbeat: sendTypingGuarded } : {}),
  };
  return createTestRegistry([{ pluginId: "demo-typing", plugin, source: "test" }]);
}

describe("keepChannelTyping", () => {
  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
    vi.useRealTimers();
  });

  it("refreshes the thread's typing until the signal aborts", async () => {
    vi.useFakeTimers();
    const sendTypingGuarded = vi.fn(async () => {});
    setActivePluginRegistry(registryWithTyping({ sendTypingGuarded }));
    const stop = new AbortController();
    const typing = keepChannelTyping({
      cfg: {},
      channel: "demo-typing",
      to: "chan-1",
      threadId: "thread-1",
      signal: stop.signal,
    });
    await vi.advanceTimersByTimeAsync(17_000);
    stop.abort();
    await expect(typing).resolves.toBeUndefined();
    expect(sendTypingGuarded).toHaveBeenCalledTimes(3);
    expect(sendTypingGuarded).toHaveBeenCalledWith(
      expect.objectContaining({ to: "chan-1", threadId: "thread-1", signal: stop.signal }),
    );
  });

  it("resolves at once for a channel without typing and rejects a failed send", async () => {
    setActivePluginRegistry(registryWithTyping());
    const signal = new AbortController().signal;
    const params = { cfg: {}, channel: "demo-typing", to: "chan-1", signal };
    await expect(keepChannelTyping(params)).resolves.toBeUndefined();

    setActivePluginRegistry(
      registryWithTyping({
        sendTypingGuarded: async () => {
          throw new Error("Missing Access");
        },
      }),
    );
    await expect(keepChannelTyping(params)).rejects.toThrow("Missing Access");
  });
});
