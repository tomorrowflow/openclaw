import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { createChannelRegistryLoader } from "../registry-loader.js";
import type { ChannelHeartbeatAdapter } from "../types.adapters.js";

// Discord shows typing for about 10 s after each call.
const TYPING_REFRESH_MS = 8_000;

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

const loadHeartbeatAdapter = createChannelRegistryLoader<ChannelHeartbeatAdapter>(
  (entry) => entry.plugin.heartbeat,
);

export type KeepChannelTypingParams = {
  cfg: OpenClawConfig;
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string | number;
  /** Typing stops when this aborts. */
  signal: AbortSignal;
};

/**
 * Shows the channel's typing indicator until `signal` aborts. Resolves on abort
 * or when the channel has no typing; rejects on the first failed send so the
 * caller decides whether a missing indicator matters.
 */
export async function keepChannelTyping(params: KeepChannelTypingParams): Promise<void> {
  const heartbeat = await loadHeartbeatAdapter(params.channel);
  const target = {
    cfg: params.cfg,
    to: params.to,
    ...(params.accountId ? { accountId: params.accountId } : {}),
    ...(params.threadId !== undefined ? { threadId: params.threadId } : {}),
  };
  const sendOnce = heartbeat?.sendTypingGuarded
    ? () =>
        heartbeat.sendTypingGuarded?.({
          ...target,
          signal: params.signal,
          assertPlatformSendAuthorized: () => params.signal.throwIfAborted(),
        })
    : heartbeat?.sendTyping
      ? () => heartbeat.sendTyping?.(target)
      : undefined;
  if (!sendOnce) {
    return;
  }
  while (!params.signal.aborted) {
    try {
      await sendOnce();
    } catch (error) {
      if (params.signal.aborted) {
        return;
      }
      throw error;
    }
    await delay(TYPING_REFRESH_MS, params.signal);
  }
}
