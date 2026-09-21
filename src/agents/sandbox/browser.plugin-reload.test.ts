// Cached browser bridges outlive the plugin generation that started them. A
// config edit that reloads plugins retires that generation, so provisioning must
// not keep handing the retired bridge to later turns.
import { describe, expect, it } from "vitest";
import { PluginInstance } from "../../plugins/plugin-instance.js";
import { createSandboxBrowserTestHarness } from "./browser.create.test-helpers.js";

const CONTAINER_NAME = "openclaw-sbx-browser-session-test-0661d10a";
const CDP_AUTH_TOKEN = "cdp-test-token";
// ensureSandboxBrowser embeds the container's CDP credentials in the profile URL
// it compares against, so the cached profile has to carry the same URL.
const CDP_URL = `http://openclaw:${CDP_AUTH_TOKEN}@127.0.0.1:49100`;

describe("ensureSandboxBrowser cached bridge plugin generation", () => {
  const harness = createSandboxBrowserTestHarness();
  const { dockerMocks, bridgeMocks, buildConfig, ensureTestSandboxBrowser } = harness;

  // Matches the running container and the requested policy, so the only thing
  // that can invalidate reuse is the owning plugin instance.
  function reusableBridge() {
    return {
      server: { listening: true } as never,
      port: 19000,
      baseUrl: "http://127.0.0.1:19000",
      state: {
        resolved: {
          enabled: true,
          evaluateEnabled: true,
          controlPort: 0,
          cdpProtocol: "http",
          cdpHost: "127.0.0.1",
          cdpIsLoopback: true,
          cdpPortRangeStart: 18800,
          cdpPortRangeEnd: 18899,
          extensionRelayDefaultPort: 18799,
          extensionRelayPorts: {},
          remoteCdpTimeoutMs: 1500,
          remoteCdpHandshakeTimeoutMs: 3000,
          localLaunchTimeoutMs: 15_000,
          localCdpReadyTimeoutMs: 8_000,
          color: "#FF4500",
          headless: false,
          noSandbox: false,
          attachOnly: true,
          defaultProfile: "openclaw",
          extraArgs: [],
          tabCleanup: {
            enabled: true,
            idleMinutes: 120,
            maxTabsPerSession: 8,
            sweepMinutes: 5,
          },
          profiles: {
            openclaw: {
              cdpPort: 49100,
              cdpUrl: CDP_URL,
              color: "#FF4500",
            },
          },
          ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
        },
      },
    };
  }

  async function provision() {
    dockerMocks.dockerContainerState.mockResolvedValue({ exists: true, running: true });
    dockerMocks.readDockerContainerEnvVar.mockImplementation(
      async (_containerName: string, key: string) =>
        key === "OPENCLAW_BROWSER_CDP_AUTH_TOKEN" ? CDP_AUTH_TOKEN : null,
    );
    return await ensureTestSandboxBrowser({
      scopeKey: "session:test",
      workspaceDir: harness.testWorkspaceDir,
      agentWorkspaceDir: harness.testWorkspaceDir,
      cfg: buildConfig(false),
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
    });
  }

  it("reuses a cached bridge owned by a live plugin instance", async () => {
    const instance = new PluginInstance("browser");
    try {
      harness.BROWSER_BRIDGES.set("session:test", {
        bridge: instance.adopt(reusableBridge()),
        containerName: CONTAINER_NAME,
        authToken: "test-bridge-token",
      });

      await provision();

      expect(bridgeMocks.startBrowserBridgeServer).not.toHaveBeenCalled();
      expect(bridgeMocks.stopBrowserBridgeServer).not.toHaveBeenCalled();
    } finally {
      await instance.dispose();
    }
  });

  it("rebuilds a cached bridge whose owning plugin instance was retired", async () => {
    const instance = new PluginInstance("browser");
    const cached = {
      bridge: instance.adopt(reusableBridge()),
      containerName: CONTAINER_NAME,
      authToken: "test-bridge-token",
    };
    harness.BROWSER_BRIDGES.set("session:test", cached);
    // A plugins.* config edit retires the generation that started this bridge.
    await instance.dispose();

    await provision();

    expect(bridgeMocks.startBrowserBridgeServer).toHaveBeenCalled();
    expect(harness.BROWSER_BRIDGES.get("session:test")).not.toBe(cached);
  });
});
