import http from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it, vi } from "vitest";
import { BROWSER_BRIDGES } from "../agents/sandbox/browser-bridges.js";
import { completeGatewayClose, prepareGatewayClose } from "./server-close.js";
import { createGatewayCloseTestDepsFactory } from "./server-close.test-support.js";

// mock-isolation: The bundled browser plugin facade is not activated here; its stop closes the server.
vi.mock("../plugin-sdk/browser-bridge.js", () => ({
  stopBrowserBridgeServer: (server: http.Server) =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
}));

it("closes cached sandbox browser bridges so the Gateway process can exit", async () => {
  const server = http.createServer((_req, res) => res.end());
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  try {
    BROWSER_BRIDGES.set("agent:main:sandboxed", {
      bridge: {
        server,
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        state: { resolved: {} as never },
      },
      containerName: "openclaw-sbx-browser-close",
    });
    const params = createGatewayCloseTestDepsFactory({
      disposeAllBundleLspRuntimes: async () => {},
      stopGmailWatcher: async () => {},
      disposeAllCodeModeRuns: async () => {},
      closeProviderTransportDispatcherPool: async () => {},
      drainRetainedEmbeddingProviders: async () => {},
    })();

    const preparation = await prepareGatewayClose(params, {
      reason: "gateway stopping",
      drainTimeoutMs: 0,
    });
    await completeGatewayClose(params, preparation);

    expect(server.listening).toBe(false);
    expect(BROWSER_BRIDGES.size).toBe(0);
  } finally {
    BROWSER_BRIDGES.clear();
    server.close();
  }
});
