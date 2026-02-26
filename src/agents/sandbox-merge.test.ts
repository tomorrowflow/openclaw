import { describe, expect, it } from "vitest";
import {
  resolveSandboxBrowserConfig,
  resolveSandboxDockerConfig,
  resolveSandboxPruneConfig,
  resolveSandboxScope,
} from "./sandbox/config.js";

describe("sandbox config merges", () => {
  it("resolves sandbox scope deterministically", () => {
    expect(resolveSandboxScope({})).toBe("agent");
    expect(resolveSandboxScope({ perSession: true })).toBe("session");
    expect(resolveSandboxScope({ perSession: false })).toBe("shared");
    expect(resolveSandboxScope({ perSession: true, scope: "agent" })).toBe("agent");
  });

  it("merges sandbox docker env and ulimits (agent wins)", () => {
    const resolved = resolveSandboxDockerConfig({
      scope: "agent",
      globalDocker: {
        env: { LANG: "C.UTF-8", FOO: "1" },
        ulimits: { nofile: { soft: 10, hard: 20 } },
      },
      agentDocker: {
        env: { FOO: "2", BAR: "3" },
        ulimits: { nproc: 256 },
      },
    });

    expect(resolved.env).toEqual({ LANG: "C.UTF-8", FOO: "2", BAR: "3" });
    expect(resolved.ulimits).toEqual({
      nofile: { soft: 10, hard: 20 },
      nproc: 256,
    });
  });

  it("resolves docker binds and shared-scope override behavior", () => {
    for (const scenario of [
      {
        name: "merges sandbox docker binds (global + agent combined)",
        input: {
          scope: "agent" as const,
          globalDocker: {
            binds: ["/var/run/docker.sock:/var/run/docker.sock"],
          },
          agentDocker: {
            binds: ["/home/user/source:/source:rw"],
          },
        },
        assert: (resolved: ReturnType<typeof resolveSandboxDockerConfig>) => {
          expect(resolved.binds).toEqual([
            "/var/run/docker.sock:/var/run/docker.sock",
            "/home/user/source:/source:rw",
          ]);
        },
      },
      {
        name: "returns undefined binds when neither global nor agent has binds",
        input: {
          scope: "agent" as const,
          globalDocker: {},
          agentDocker: {},
        },
        assert: (resolved: ReturnType<typeof resolveSandboxDockerConfig>) => {
          expect(resolved.binds).toBeUndefined();
        },
      },
      {
        name: "ignores agent binds under shared scope",
        input: {
          scope: "shared" as const,
          globalDocker: {
            binds: ["/var/run/docker.sock:/var/run/docker.sock"],
          },
          agentDocker: {
            binds: ["/home/user/source:/source:rw"],
          },
        },
        assert: (resolved: ReturnType<typeof resolveSandboxDockerConfig>) => {
          expect(resolved.binds).toEqual(["/var/run/docker.sock:/var/run/docker.sock"]);
        },
      },
      {
        name: "ignores agent docker overrides under shared scope",
        input: {
          scope: "shared" as const,
          globalDocker: { image: "global" },
          agentDocker: { image: "agent" },
        },
        assert: (resolved: ReturnType<typeof resolveSandboxDockerConfig>) => {
          expect(resolved.image).toBe("global");
        },
      },
    ]) {
      const resolved = resolveSandboxDockerConfig(scenario.input);
      scenario.assert(resolved);
    }
  });

  it("merges sandbox docker secretMounts (agent wins per-key)", () => {
    const resolved = resolveSandboxDockerConfig({
      scope: "agent",
      globalDocker: {
        secretMounts: {
          ANTHROPIC_API_KEY: "/home/user/.secrets/anthropic",
          SHARED_KEY: "/home/user/.secrets/shared",
        },
      },
      agentDocker: {
        secretMounts: {
          OPENAI_API_KEY: "/home/user/.secrets/openai",
          SHARED_KEY: "/home/user/.secrets/shared-override",
        },
      },
    });
    expect(resolved.secretMounts).toEqual({
      ANTHROPIC_API_KEY: "/home/user/.secrets/anthropic",
      SHARED_KEY: "/home/user/.secrets/shared-override",
      OPENAI_API_KEY: "/home/user/.secrets/openai",
    });
  });

  it("returns undefined secretMounts when neither global nor agent has them", () => {
    const resolved = resolveSandboxDockerConfig({
      scope: "agent",
      globalDocker: {},
      agentDocker: {},
    });
    expect(resolved.secretMounts).toBeUndefined();
  });

  it("ignores agent secretMounts under shared scope", () => {
    const resolved = resolveSandboxDockerConfig({
      scope: "shared",
      globalDocker: {
        secretMounts: { GLOBAL_KEY: "/home/user/.secrets/global" },
      },
      agentDocker: {
        secretMounts: { AGENT_KEY: "/home/user/.secrets/agent" },
      },
    });
    expect(resolved.secretMounts).toEqual({
      GLOBAL_KEY: "/home/user/.secrets/global",
    });
  });

  it("applies per-agent browser and prune overrides (ignored under shared scope)", () => {
    const browser = resolveSandboxBrowserConfig({
      scope: "agent",
      globalBrowser: { enabled: false, headless: false, enableNoVnc: true },
      agentBrowser: { enabled: true, headless: true, enableNoVnc: false },
    });
    expect(browser.enabled).toBe(true);
    expect(browser.headless).toBe(true);
    expect(browser.enableNoVnc).toBe(false);

    const prune = resolveSandboxPruneConfig({
      scope: "agent",
      globalPrune: { idleHours: 24, maxAgeDays: 7 },
      agentPrune: { idleHours: 0, maxAgeDays: 1 },
    });
    expect(prune).toEqual({ idleHours: 0, maxAgeDays: 1 });

    const browserShared = resolveSandboxBrowserConfig({
      scope: "shared",
      globalBrowser: { enabled: false },
      agentBrowser: { enabled: true },
    });
    expect(browserShared.enabled).toBe(false);

    const pruneShared = resolveSandboxPruneConfig({
      scope: "shared",
      globalPrune: { idleHours: 24, maxAgeDays: 7 },
      agentPrune: { idleHours: 0, maxAgeDays: 1 },
    });
    expect(pruneShared).toEqual({ idleHours: 24, maxAgeDays: 7 });
  });
});
