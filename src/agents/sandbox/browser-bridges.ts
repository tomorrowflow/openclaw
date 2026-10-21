/**
 * In-process browser bridge registry keyed by sandbox session.
 *
 * The prune path uses this table to stop bridge servers when backing containers expire.
 */
import type { Server } from "node:http";
import { type BrowserBridge, stopBrowserBridgeServer } from "../../plugin-sdk/browser-bridge.js";
import { getPluginValueInstance } from "../../plugins/plugin-instance-scope.js";

export type CachedBrowserBridge = {
  bridge: BrowserBridge;
  containerName: string;
  authToken?: string;
  authPassword?: string;
};

export const BROWSER_BRIDGES = new Map<string, CachedBrowserBridge>();

function closeRetiredBridgeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/** Stop and remove only the cached bridge instance the caller inspected. */
export async function stopCachedBrowserBridge(
  sessionKey: string,
  expected: CachedBrowserBridge,
  assertCurrent?: () => void,
): Promise<void> {
  assertCurrent?.();
  if (BROWSER_BRIDGES.get(sessionKey) !== expected) {
    return;
  }
  // Disposing a plugin generation leaves the bridges it started listening, and
  // calling back into the retired owner only raises the retired-instance error.
  // Close the listener directly so it cannot keep the Gateway process alive.
  if (getPluginValueInstance(expected.bridge)?.acceptingCalls === false) {
    BROWSER_BRIDGES.delete(sessionKey);
    await closeRetiredBridgeServer(expected.bridge.server);
    return;
  }
  await stopBrowserBridgeServer(expected.bridge.server);
  assertCurrent?.();
  if (BROWSER_BRIDGES.get(sessionKey) === expected) {
    BROWSER_BRIDGES.delete(sessionKey);
  }
}

/** Stop every cached bridge; a listening bridge keeps the Gateway process alive after close. */
export async function stopAllCachedBrowserBridges(): Promise<void> {
  const results = await Promise.allSettled(
    [...BROWSER_BRIDGES].map(([sessionKey, cached]) => stopCachedBrowserBridge(sessionKey, cached)),
  );
  const failure = results.find((result) => result.status === "rejected");
  if (failure) {
    throw failure.reason;
  }
}

/** Drain every cached bridge that still owns one sandbox container. */
export async function stopCachedBrowserBridgesForContainer(
  containerName: string,
  assertCurrent?: () => void,
): Promise<void> {
  for (;;) {
    const match = [...BROWSER_BRIDGES].find(([, cached]) => cached.containerName === containerName);
    if (!match) {
      return;
    }
    await stopCachedBrowserBridge(match[0], match[1], assertCurrent);
  }
}
