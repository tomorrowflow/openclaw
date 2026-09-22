// Runs on the system agent's execution config are tool-free (the setup probe) or
// limited to the in-process "openclaw" tool, so the projection must not carry the
// operator's sandboxing into them.
import { describe, expect, it } from "vitest";
import { resolveSandboxConfigForAgent } from "../agents/sandbox/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { SYSTEM_AGENT_ID } from "./agent-id.js";
import { resolveSystemAgentConfiguredRouteFromConfig } from "./inference-route.js";

function sandboxedConfig(): OpenClawConfig {
  return {
    agents: {
      entries: {
        main: {
          default: true,
          agentDir: "/tmp/openclaw-agent",
          sandbox: { mode: "all", workspaceAccess: "rw" },
        },
      },
      defaults: {
        model: "openai/gpt-5.6-sol",
        workspace: "/tmp/openclaw-workspace",
        sandbox: {
          mode: "all",
          workspaceAccess: "rw",
          browser: { enabled: true, autoStart: true },
        },
      },
    },
  };
}

describe("system agent execution config", () => {
  it("projects a sandbox-free run config without touching the operator's own", async () => {
    const config = sandboxedConfig();
    const route = await resolveSystemAgentConfiguredRouteFromConfig(config, "main");

    expect(route).not.toBeNull();
    // The probe runs as the route agent; the assistant turn runs as the system agent.
    expect(resolveSandboxConfigForAgent(route?.runConfig, "main").mode).toBe("off");
    expect(resolveSandboxConfigForAgent(route?.runConfig, SYSTEM_AGENT_ID).mode).toBe("off");
    // The source config keeps the operator's sandboxing for every other reader.
    expect(resolveSandboxConfigForAgent(route?.sourceConfig, "main").mode).toBe("all");
    expect(resolveSandboxConfigForAgent(config, "main").mode).toBe("all");
  });
});
