import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { setActiveDegradedSecretOwners } from "../../secrets/runtime-degraded-state.js";
import { resolveSandboxContext } from "./context.js";
import { isSandboxProvisioningError } from "./provisioning-error.js";

afterEach(() => {
  setActiveDegradedSecretOwners([]);
});

describe("sandbox SSH secret owner", () => {
  it("classifies an unmaterialized inherited ref as terminal sandbox provisioning", async () => {
    const config: OpenClawConfig = {
      agents: {
        entries: { main: {} },
        defaults: {
          sandbox: {
            mode: "all",
            backend: "ssh",
            ssh: {
              target: "sandbox@example.com:22",
              identityData: {
                source: "env",
                provider: "default",
                id: "UNMATERIALIZED_SANDBOX_IDENTITY",
              },
            },
          },
        },
      },
    };

    const error = await resolveSandboxContext({
      config,
      agentId: "unlisted",
      sessionKey: "agent:unlisted:main",
    }).catch((caught: unknown) => caught);

    expect(isSandboxProvisioningError(error)).toBe(true);
    expect(error).toMatchObject({
      code: "sandbox_provisioning",
      backendId: "ssh",
      message: expect.stringContaining("openclaw secrets reload"),
      cause: {
        code: "SECRET_SURFACE_UNAVAILABLE",
        ownerKind: "capability",
        ownerId: "agent-sandbox:unlisted",
        paths: ["agents.defaults.sandbox.ssh.identityData"],
      },
    });
  });
});

describe("sandbox docker env secret owner", () => {
  it("rejects an unmaterialized docker env ref before provisioning", async () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: { sandbox: { mode: "all" } },
        entries: {
          worker: {
            sandbox: {
              docker: {
                env: { GH_TOKEN: { source: "store", provider: "default", id: "GH_TOKEN" } },
              },
            },
          },
        },
      },
    };

    const error = await resolveSandboxContext({
      config,
      agentId: "worker",
      sessionKey: "agent:worker:main",
    }).catch((caught: unknown) => caught);

    expect(isSandboxProvisioningError(error)).toBe(true);
    expect(error).toMatchObject({
      backendId: "docker",
      cause: {
        code: "SECRET_SURFACE_UNAVAILABLE",
        ownerId: "agent-sandbox:worker",
        paths: ["agents.entries.worker.sandbox.docker.env.GH_TOKEN"],
      },
    });
  });

  it("names the config path when a resolved docker env value cannot cross the env file", async () => {
    const config: OpenClawConfig = {
      agents: {
        entries: { main: {} },
        defaults: {
          sandbox: { mode: "all", docker: { env: { GH_TOKEN: "first-line\nsecond-line" } } },
        },
      },
    };

    const error = await resolveSandboxContext({
      config,
      agentId: "main",
      sessionKey: "agent:main:main",
    }).catch((caught: unknown) => caught);

    expect(isSandboxProvisioningError(error)).toBe(true);
    const cause = String((error as { cause?: unknown }).cause);
    expect(cause).toContain(
      "agents.defaults.sandbox.docker.env.GH_TOKEN resolved to a value the Docker sandbox cannot pass",
    );
    expect(cause).not.toContain("second-line");
  });

  it("refuses a container sandbox while the retired secretMounts key remains", async () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: { sandbox: { mode: "all" } },
        entries: {
          worker: { sandbox: { docker: { secretMounts: { GH_TOKEN: "/run/gh-token" } } } },
        },
      },
    };

    const error = await resolveSandboxContext({
      config,
      agentId: "worker",
      sessionKey: "agent:worker:main",
    }).catch((caught: unknown) => caught);

    expect(isSandboxProvisioningError(error)).toBe(true);
    expect(String((error as { cause?: unknown }).cause)).toContain(
      "agents.entries.worker.sandbox.docker.secretMounts is retired",
    );
  });
});
