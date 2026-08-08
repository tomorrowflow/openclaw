// Docker sandbox recreation tests cover Podman-specific config-hash labels,
// bind ordering, and init/tmpfs behavior used to decide when shared containers
// must be rebuilt.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeSandboxConfigHash } from "./config-hash.js";
import { SANDBOX_DOCKER_CREATE_ARGS_EPOCH } from "./constants.js";
import { collectDockerFlagValues } from "./test-args.js";
import type { SandboxConfig } from "./types.js";
import { SANDBOX_MOUNT_FORMAT_VERSION } from "./workspace-mounts.js";

type SpawnCall = {
  command: string;
  args: string[];
  globalArgs: string[];
};

const spawnState = vi.hoisted(() => ({
  calls: [] as SpawnCall[],
  containerExists: true,
  inspectRunning: true,
  inspectError: "",
  labelHash: "",
  podmanInfo: "true\tfalse\t\t5.0.0\n",
  podmanConnections: "[]\n",
  podmanMachines: "[]\n",
}));

const registryMocks = vi.hoisted(() => ({
  readRegistryEntry: vi.fn(),
  removeRegistryEntry: vi.fn(),
  updateRegistry: vi.fn(),
}));

const runtimeMocks = vi.hoisted(() => ({
  log: vi.fn(),
}));

const tmpDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-docker-mounts-"));
  tmpDirs.push(dir);
  return dir;
}

function usePodmanMachine() {
  spawnState.podmanInfo = "true\ttrue\t\t5.0.0\n";
  spawnState.podmanConnections = JSON.stringify([
    {
      Name: "podman-machine-default",
      URI: "ssh://core@127.0.0.1:60000/run/user/501/podman/podman.sock",
      Identity: "/tmp/podman-machine-default",
      Default: true,
    },
  ]);
  spawnState.podmanMachines = JSON.stringify([
    {
      Name: "podman-machine-default",
      Running: true,
      IdentityPath: "/tmp/podman-machine-default",
      Port: 60000,
      RemoteUsername: "core",
    },
  ]);
}

vi.mock("./registry.js", () => ({
  readRegistryEntry: registryMocks.readRegistryEntry,
  removeRegistryEntry: registryMocks.removeRegistryEntry,
  updateRegistry: registryMocks.updateRegistry,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: runtimeMocks,
}));

async function spawnDockerProcess(commandAndArgs: string[]) {
  const [command = "", ...rawArgs] = commandAndArgs;
  const globalArgs: string[] = [];
  let args = rawArgs;
  if (command === "podman") {
    while (args[0] === "--url" || args[0] === "--identity") {
      globalArgs.push(...args.slice(0, 2));
      args = args.slice(2);
    }
  }
  spawnState.calls.push({ command, args, globalArgs });

  let code = 0;
  let stdout = "";
  let stderr = "";
  if (command !== "docker" && command !== "podman") {
    code = 1;
    stderr = `unexpected command: ${command}`;
  } else if (args[0] === "inspect" && args[1] === "-f" && args[2] === "{{.State.Running}}") {
    if (spawnState.inspectError) {
      code = 125;
      stderr = spawnState.inspectError;
    } else if (!spawnState.containerExists) {
      code = 1;
      stderr = "No such object";
    } else {
      stdout = spawnState.inspectRunning ? "true\n" : "false\n";
    }
  } else if (
    args[0] === "inspect" &&
    args[1] === "-f" &&
    args[2]?.includes('index .Config.Labels "openclaw.configHash"')
  ) {
    if (!spawnState.containerExists) {
      code = 1;
      stderr = "No such object";
    } else {
      stdout = `${spawnState.labelHash}\n`;
    }
  } else if (command === "podman" && args[0] === "info") {
    stdout = spawnState.podmanInfo;
  } else if (command === "podman" && args[0] === "system") {
    stdout = spawnState.podmanConnections;
  } else if (command === "podman" && args[0] === "machine") {
    stdout = spawnState.podmanMachines;
  } else if (args[0] === "rm" && args[1] === "-f") {
    spawnState.containerExists = false;
    spawnState.inspectRunning = false;
  } else if (args[0] === "image" && args[1] === "inspect") {
    code = 0;
  } else if (args[0] === "create") {
    if (spawnState.containerExists) {
      code = 1;
      stderr = "container name is already in use";
    } else {
      spawnState.containerExists = true;
      spawnState.inspectRunning = false;
      spawnState.labelHash =
        args
          .find((arg) => arg.startsWith("openclaw.configHash="))
          ?.slice("openclaw.configHash=".length) ?? "";
    }
  } else if (args[0] === "start") {
    spawnState.inspectRunning = true;
  } else if (args[0] === "exec") {
    code = 0;
  } else {
    code = 1;
    stderr = `unexpected docker args: ${args.join(" ")}`;
  }
  return {
    failed: code !== 0,
    isCanceled: false,
    exitCode: code,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
  };
}

vi.mock("../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec.js")>()),
  spawnCommand: spawnDockerProcess,
}));

let ensureSandboxContainer: typeof import("./docker.js").ensureSandboxContainer;
let resolveDockerEnvPolicyEpoch: typeof import("./docker.js").resolveDockerEnvPolicyEpoch;
let PODMAN_SANDBOX_ENGINE: typeof import("./docker.js").PODMAN_SANDBOX_ENGINE;

async function loadFreshDockerModuleForTest() {
  vi.resetModules();
  vi.doMock("./registry.js", () => ({
    readRegistryEntry: registryMocks.readRegistryEntry,
    removeRegistryEntry: registryMocks.removeRegistryEntry,
    updateRegistry: registryMocks.updateRegistry,
  }));
  vi.doMock("../../process/exec.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../process/exec.js")>()),
    spawnCommand: spawnDockerProcess,
  }));
  ({ ensureSandboxContainer, resolveDockerEnvPolicyEpoch, PODMAN_SANDBOX_ENGINE } =
    await import("./docker.js"));
}

function createSandboxConfig(
  dns: string[],
  binds?: string[],
  workspaceAccess: "rw" | "ro" | "none" = "rw",
  env: Record<string, string> = { LANG: "C.UTF-8" },
): SandboxConfig {
  return {
    mode: "all",
    backend: "docker",
    scope: "shared",
    workspaceAccess,
    workspaceRoot: "~/.openclaw/sandboxes",
    dockerTmpfsSource: "default",
    docker: {
      image: "openclaw-sandbox:test",
      containerPrefix: "oc-test-",
      workdir: "/workspace",
      readOnlyRoot: true,
      tmpfs: ["/tmp", "/var/tmp", "/run"],
      network: "none",
      capDrop: ["ALL"],
      env,
      dns,
      extraHosts: ["host.docker.internal:host-gateway"],
      binds: binds ?? ["/tmp/workspace:/workspace:rw"],
      dangerouslyAllowReservedContainerTargets: true,
    },
    ssh: {
      command: "ssh",
      workspaceRoot: "/tmp/openclaw-sandboxes",
      strictHostKeyChecking: true,
      updateHostKeys: true,
    },
    browser: {
      enabled: false,
      image: "openclaw-browser:test",
      containerPrefix: "oc-browser-",
      network: "openclaw-sandbox-browser",
      cdpPort: 9222,
      vncPort: 5900,
      noVncPort: 6080,
      headless: true,
      noVncEnabled: false,
      allowHostControl: false,
      autoStart: false,
      autoStartTimeoutMs: 5000,
    },
    tools: { allow: [], deny: [] },
    prune: { idleHours: 24, maxAgeDays: 7 },
  };
}

async function ensureSandboxCreateCallForTest(params: {
  cfg: SandboxConfig;
  workspaceDir?: string;
  scopeKey?: string;
  engine?: import("./docker.js").SandboxContainerEngine;
}): Promise<SpawnCall> {
  const workspaceDir = params.workspaceDir ?? "/tmp/workspace";
  await ensureSandboxContainer({
    scopeKey: params.scopeKey ?? "shared",
    workspaceDir,
    agentWorkspaceDir: workspaceDir,
    cfg: params.cfg,
    ...(params.engine ? { engine: params.engine } : {}),
  });

  const createCall = spawnState.calls.find(
    (call) => call.command === (params.engine?.command ?? "docker") && call.args[0] === "create",
  );
  if (!createCall) {
    throw new Error(`expected ${params.engine?.command ?? "docker"} create call`);
  }
  return createCall;
}

describe("ensureSandboxContainer Podman-specific config-hash recreation", () => {
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  beforeEach(async () => {
    spawnState.calls.length = 0;
    spawnState.containerExists = true;
    spawnState.inspectRunning = true;
    spawnState.inspectError = "";
    spawnState.labelHash = "";
    spawnState.podmanInfo = "true\tfalse\t\t5.0.0\n";
    spawnState.podmanConnections = "[]\n";
    spawnState.podmanMachines = "[]\n";
    registryMocks.readRegistryEntry.mockClear();
    registryMocks.removeRegistryEntry.mockClear();
    registryMocks.removeRegistryEntry.mockResolvedValue(undefined);
    registryMocks.updateRegistry.mockClear();
    registryMocks.updateRegistry.mockResolvedValue(undefined);
    runtimeMocks.log.mockClear();
    await loadFreshDockerModuleForTest();
  });

  it("uses collision-safe Docker name truncation for a long container prefix", async () => {
    const cfg = createSandboxConfig([]);
    cfg.scope = "session";
    cfg.docker.containerPrefix = "x".repeat(56);
    spawnState.inspectRunning = false;
    registryMocks.readRegistryEntry.mockResolvedValue(null);

    const createCall = await ensureSandboxCreateCallForTest({
      cfg,
      scopeKey: "agent:first:session",
    });
    const containerName = collectDockerFlagValues(createCall.args, "--name")[0];

    expect(containerName).toHaveLength(63);
    expect(containerName).toMatch(/^x{50}-[a-f0-9]{12}$/);
  });

  it("preserves distinct session suffixes with a long Podman container prefix", async () => {
    const cfg = createSandboxConfig([]);
    cfg.scope = "session";
    cfg.docker.containerPrefix = "x".repeat(56);
    cfg.docker.user = undefined;
    spawnState.containerExists = false;
    spawnState.inspectRunning = false;
    registryMocks.readRegistryEntry.mockResolvedValue(null);

    const firstCreate = await ensureSandboxCreateCallForTest({
      cfg,
      scopeKey: "agent:first:session",
      engine: PODMAN_SANDBOX_ENGINE,
    });
    const firstName = collectDockerFlagValues(firstCreate.args, "--name")[0];

    spawnState.calls.length = 0;
    spawnState.containerExists = false;
    const secondCreate = await ensureSandboxCreateCallForTest({
      cfg,
      scopeKey: "agent:second:session",
      engine: PODMAN_SANDBOX_ENGINE,
    });
    const secondName = collectDockerFlagValues(secondCreate.args, "--name")[0];

    expect(firstName).not.toBe(secondName);
    expect(firstName?.length).toBeLessThanOrEqual(63);
    expect(secondName?.length).toBeLessThanOrEqual(63);
  });

  it("uses Podman init when mounts leave podman-init visible", async () => {
    const cfg = createSandboxConfig([]);
    cfg.docker.tmpfs = ["/tmp", "/var/tmp"];
    spawnState.inspectRunning = false;
    registryMocks.readRegistryEntry.mockResolvedValue(null);

    const createCall = await ensureSandboxCreateCallForTest({
      cfg,
      engine: PODMAN_SANDBOX_ENGINE,
    });

    expect(createCall.args).toContain("--init");
  });

  it("rejects a workdir whose managed workspace bind would cover Podman init", async () => {
    const cfg = createSandboxConfig([]);
    cfg.docker.workdir = "/run";
    spawnState.inspectRunning = false;
    registryMocks.readRegistryEntry.mockResolvedValue(null);

    await expect(
      ensureSandboxCreateCallForTest({ cfg, engine: PODMAN_SANDBOX_ENGINE }),
    ).rejects.toThrow("would cover Podman's init path");
  });

  it("omits the default /run tmpfs for writable-root Podman sandboxes", async () => {
    const cfg = createSandboxConfig([]);
    cfg.docker.readOnlyRoot = false;
    spawnState.inspectRunning = false;
    registryMocks.readRegistryEntry.mockResolvedValue(null);

    const createCall = await ensureSandboxCreateCallForTest({
      cfg,
      engine: PODMAN_SANDBOX_ENGINE,
    });

    expect(createCall.args).toContain("--init");
    expect(createCall.args).not.toContain("--read-only-tmpfs=true");
    expect(collectDockerFlagValues(createCall.args, "--tmpfs")).toEqual(["/tmp", "/var/tmp"]);
  });

  it("rejects an explicitly configured bare /run tmpfs", async () => {
    const cfg = createSandboxConfig([]);
    cfg.dockerTmpfsSource = "configured";
    cfg.docker.readOnlyRoot = false;
    cfg.docker.tmpfs = ["/run"];
    spawnState.inspectRunning = false;
    registryMocks.readRegistryEntry.mockResolvedValue(null);

    await expect(
      ensureSandboxCreateCallForTest({ cfg, engine: PODMAN_SANDBOX_ENGINE }),
    ).rejects.toThrow("would cover Podman's init path");
  });

  it("invalidates a Podman container when the same tmpfs list becomes explicit", async () => {
    const workspaceDir = makeTempDir();
    const cfg = createSandboxConfig([], [`${workspaceDir}:/workspace:rw`]);
    const genericHash = computeSandboxConfigHash({
      docker: cfg.docker,
      dockerEnvPolicyEpoch: resolveDockerEnvPolicyEpoch(cfg.docker.env),
      workspaceAccess: cfg.workspaceAccess,
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION,
      createArgsEpoch: SANDBOX_DOCKER_CREATE_ARGS_EPOCH,
      readOnlyWorkspaceSkillMounts: [],
    });
    const oldHash = `${genericHash}:podman-runtime-v8:keep-id:default`;
    cfg.dockerTmpfsSource = "configured";
    spawnState.inspectRunning = false;
    spawnState.labelHash = oldHash;
    registryMocks.readRegistryEntry.mockResolvedValue({
      containerName: "oc-test-podman-shared",
      backendId: "podman",
      backendTarget: { key: "local", globalArgs: [] },
      sessionKey: "shared",
      createdAtMs: 1,
      lastUsedAtMs: 0,
      image: cfg.docker.image,
      configHash: oldHash,
    });

    await expect(
      ensureSandboxContainer({
        engine: PODMAN_SANDBOX_ENGINE,
        scopeKey: "agent:main:session-1",
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        cfg,
      }),
    ).rejects.toThrow("would cover Podman's init path");

    expect(
      spawnState.calls.some(
        (call) => call.command === "podman" && call.args[0] === "rm" && call.args[1] === "-f",
      ),
    ).toBe(true);
  });

  it("rejects customized /run tmpfs options instead of discarding them", async () => {
    const cfg = createSandboxConfig([]);
    cfg.dockerTmpfsSource = "configured";
    cfg.docker.tmpfs = ["/run:size=64m,mode=0700"];
    spawnState.inspectRunning = false;
    registryMocks.readRegistryEntry.mockResolvedValue(null);

    await expect(
      ensureSandboxCreateCallForTest({ cfg, engine: PODMAN_SANDBOX_ENGINE }),
    ).rejects.toThrow("would cover Podman's init path");
  });

  it("allows Podman Machine workspaces under the default home share", async () => {
    const cfg = createSandboxConfig([]);
    const workspaceDir = path.join(os.homedir(), "openclaw-podman-workspace");
    cfg.docker.binds = [`${workspaceDir}:/workspace:rw`];
    usePodmanMachine();
    spawnState.inspectRunning = false;
    registryMocks.readRegistryEntry.mockResolvedValue(null);

    const createCall = await ensureSandboxCreateCallForTest({
      cfg,
      workspaceDir,
      engine: PODMAN_SANDBOX_ENGINE,
    });

    expect(createCall.command).toBe("podman");
    expect(createCall.globalArgs).toEqual([
      "--url",
      "ssh://core@127.0.0.1:60000/run/user/501/podman/podman.sock",
      "--identity",
      "/tmp/podman-machine-default",
    ]);
  });

  it("rejects Podman Machine bind sources outside the default home share", async () => {
    const cfg = createSandboxConfig([]);
    usePodmanMachine();
    spawnState.inspectRunning = false;
    registryMocks.readRegistryEntry.mockResolvedValue(null);

    await expect(
      ensureSandboxContainer({
        engine: PODMAN_SANDBOX_ENGINE,
        scopeKey: "agent:test:session",
        workspaceDir: "/tmp/workspace",
        agentWorkspaceDir: "/tmp/workspace",
        cfg,
      }),
    ).rejects.toThrow(/outside the default host home share/u);

    expect(spawnState.calls.some((call) => call.args[0] === "create")).toBe(false);
  });
});
