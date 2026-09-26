// Sandboxed agents name files by container path, so the Gateway file surface
// must translate them through the sandbox mount table before serving them.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSandboxConfigForAgent } from "../../agents/sandbox/config.js";
import { resolveSandboxWorkspaceLayoutPaths } from "../../agents/sandbox/shared.js";
import { sessionsFilesHandlers } from "./sessions-files.js";
import {
  assistantToolCall,
  createSessionFilesHandlerInvoker,
  createVisibleMessagesMock,
  expectError,
  expectOkPayload,
  hashContent,
  prepareSessionFilesTest,
  removeWorkspaceFixture,
  writeWorkspaceFile,
} from "./sessions-files.test-support.js";

const hoisted = vi.hoisted(() => ({
  execOpenPath: vi.fn(),
  loadSessionEntry: vi.fn(),
  resolveAgentWorkspaceDir: vi.fn(),
  resolveDefaultAgentId: vi.fn(),
  readSessionTranscriptVisibleMessageDeltaCore: vi.fn(),
  readRegisteredSandboxRuntimeIds: vi.fn(),
  readRegistryEntry: vi.fn(),
}));

vi.mock("../../agents/sandbox/registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/sandbox/registry.js")>()),
  readRegisteredSandboxRuntimeIds: hoisted.readRegisteredSandboxRuntimeIds,
  readRegistryEntry: hoisted.readRegistryEntry,
}));

vi.mock("./open-path.js", async () => {
  const actual = await vi.importActual<typeof import("./open-path.js")>("./open-path.js");
  return { ...actual, execOpenPath: hoisted.execOpenPath };
});

vi.mock("../../agents/agent-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/agent-scope.js")>()),
  resolveAgentWorkspaceDir: hoisted.resolveAgentWorkspaceDir,
  resolveDefaultAgentId: hoisted.resolveDefaultAgentId,
}));

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    loadSessionEntry: hoisted.loadSessionEntry,
    loadGatewaySessionEntryReadOnly: hoisted.loadSessionEntry,
  };
});

vi.mock("../session-transcript-readers.js", async () => {
  const actual = await vi.importActual<typeof import("../session-transcript-readers.js")>(
    "../session-transcript-readers.js",
  );
  return {
    ...actual,
    readSessionTranscriptVisibleMessageDeltaCore:
      hoisted.readSessionTranscriptVisibleMessageDeltaCore,
  };
});

const invokeSessionFilesHandler = createSessionFilesHandlerInvoker(sessionsFilesHandlers);
const mockVisibleMessages = createVisibleMessagesMock(
  hoisted.readSessionTranscriptVisibleMessageDeltaCore,
);

/** Re-points the session entry at a sandboxed agent; binds are operator mounts. */
function useSandboxedSession(
  workspaceRoot: string,
  opts: { binds?: string[]; mode?: string; canonicalKey?: string } = {},
): void {
  const { binds, mode = "all", canonicalKey = "agent:main:main" } = opts;
  hoisted.loadSessionEntry.mockReturnValue({
    agentId: "main",
    canonicalKey,
    cfg: {
      agents: {
        defaults: {
          sandbox: {
            mode,
            workspaceAccess: "rw",
            ...(binds ? { docker: { binds } } : {}),
          },
        },
      },
    },
    storePath: path.join(workspaceRoot, ".sessions.json"),
    entry: {
      sessionId: "sess-main",
      sessionFile: "sess-main.jsonl",
      spawnedCwd: workspaceRoot,
    },
  });
}

describe("sessions.files container paths", () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = prepareSessionFilesTest(hoisted, mockVisibleMessages);
    // No registered container by default: the derived mapping serves these.
    hoisted.readRegisteredSandboxRuntimeIds.mockResolvedValue([]);
    hoisted.readRegistryEntry.mockResolvedValue(null);
  });

  afterEach(() => {
    removeWorkspaceFixture(workspaceRoot);
  });

  it("previews a workspace file the agent named by its container path", async () => {
    useSandboxedSession(workspaceRoot);

    const payload = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.get", {
        sessionKey: "agent:main:main",
        path: "/workspace/src/readme.md",
      }),
    );

    expect(payload.file.content).toBe("# Read me\n");
    expect(payload.file.workspacePath).toBe("src/readme.md");
  });

  it("follows a nested mount to its own host root instead of the workspace root", async () => {
    // Both directories exist, so resolving the container prefix by string alone
    // would serve the wrong file rather than fail.
    writeWorkspaceFile(workspaceRoot, "exchange/note.md", "# Exchanged\n");
    writeWorkspaceFile(workspaceRoot, "shared/note.md", "# Not the mount source\n");
    useSandboxedSession(workspaceRoot, {
      binds: [`${path.join(workspaceRoot, "exchange")}:/workspace/shared`],
    });

    const payload = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.get", {
        sessionKey: "agent:main:main",
        path: "/workspace/shared/note.md",
      }),
    );

    expect(payload.file.content).toBe("# Exchanged\n");
    expect(payload.file.workspacePath).toBe("exchange/note.md");
  });

  it("previews a file the agent recorded in the transcript by container path", async () => {
    // The touched entry keeps the container spelling, so serving it needs the
    // same translation an untouched path already gets.
    mockVisibleMessages([assistantToolCall("read", { path: "/workspace/src/readme.md" })]);
    useSandboxedSession(workspaceRoot);

    const payload = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.get", {
        sessionKey: "agent:main:main",
        path: "/workspace/src/readme.md",
      }),
    );

    expect(payload.file.content).toBe("# Read me\n");
    expect(payload.file.workspacePath).toBe("src/readme.md");
  });

  it("lists the container-path files the agent touched and marks them in the tree", async () => {
    mockVisibleMessages([assistantToolCall("edit", { path: "/workspace/ui/chat.ts" })]);
    useSandboxedSession(workspaceRoot);

    const payload = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.list", {
        sessionKey: "agent:main:main",
      }),
    );

    expect(
      payload.files.map((file: { workspacePath?: string; missing?: boolean }) => [
        file.workspacePath,
        file.missing,
      ]),
    ).toEqual([["ui/chat.ts", false]]);
    expect(
      payload.browser?.entries.find((entry: { path: string }) => entry.path === "ui"),
    ).toMatchObject({ sessionKind: "modified" });
  });

  it("browses the directory a revealed container path points at", async () => {
    useSandboxedSession(workspaceRoot);

    const payload = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.list", {
        sessionKey: "agent:main:main",
        path: "/workspace/src",
      }),
    );

    expect(payload.browser?.path).toBe("src");
    expect(payload.browser?.entries.map((entry: { path: string }) => entry.path)).toContain(
      "src/readme.md",
    );
  });

  it("saves a file opened by container path back to the same host file", async () => {
    useSandboxedSession(workspaceRoot);

    const payload = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.set", {
        sessionKey: "agent:main:main",
        path: "/workspace/ui/vite.config.ts",
        content: "export default { sandbox: true };\n",
        expectedHash: hashContent("export default {};\n"),
      }),
    );

    expect(fs.readFileSync(path.join(workspaceRoot, "ui/vite.config.ts"), "utf8")).toBe(
      "export default { sandbox: true };\n",
    );
    expect(payload.file.workspacePath).toBe("ui/vite.config.ts");
  });

  it("refuses a container path that no mount maps into this workspace", async () => {
    useSandboxedSession(workspaceRoot);

    const error = expectError(
      await invokeSessionFilesHandler("sessions.files.get", {
        sessionKey: "agent:main:main",
        path: "/etc/hostname",
      }),
    );

    expect(error).toMatchObject({ details: { type: "session_file_not_found" } });
  });

  it("leaves container paths unresolved for a non-main session that runs on the host", async () => {
    // "non-main" sandboxes every session except the agent's own main one, where
    // /workspace/... is a literal host path rather than a container path.
    useSandboxedSession(workspaceRoot, { mode: "non-main" });

    const error = expectError(
      await invokeSessionFilesHandler("sessions.files.get", {
        sessionKey: "agent:main:main",
        path: "/workspace/src/readme.md",
      }),
    );

    expect(error).toMatchObject({ details: { type: "session_file_not_found" } });
  });

  it("still translates for a non-main session that is sandboxed", async () => {
    useSandboxedSession(workspaceRoot, {
      mode: "non-main",
      canonicalKey: "agent:main:sidequest",
    });

    const payload = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.get", {
        sessionKey: "agent:main:sidequest",
        path: "/workspace/src/readme.md",
      }),
    );

    expect(payload.file.workspacePath).toBe("src/readme.md");
  });

  it("prefers the container's recorded mapping over one derived from config", async () => {
    // The container still mounts `old` at /workspace/shared while config now
    // names `new`. Both resolve inside the root, so deriving would serve a real
    // but wrong file rather than fail.
    writeWorkspaceFile(workspaceRoot, "old/note.md", "# From the live container\n");
    writeWorkspaceFile(workspaceRoot, "new/note.md", "# From stale config\n");
    useSandboxedSession(workspaceRoot, {
      binds: [`${path.join(workspaceRoot, "new")}:/workspace/shared`],
    });
    hoisted.readRegisteredSandboxRuntimeIds.mockResolvedValue(["openclaw-sbx-workspace-live"]);
    hoisted.readRegistryEntry.mockResolvedValue({
      containerName: "openclaw-sbx-workspace-live",
      mounts: [
        { hostPath: workspaceRoot, containerPath: "/workspace" },
        { hostPath: path.join(workspaceRoot, "old"), containerPath: "/workspace/shared" },
      ],
    });

    const payload = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.get", {
        sessionKey: "agent:main:main",
        path: "/workspace/shared/note.md",
      }),
    );

    expect(payload.file.content).toBe("# From the live container\n");
    expect(payload.file.workspacePath).toBe("old/note.md");
  });

  it("serves materialized skills mounted from outside the session root read-only", async () => {
    // Materialized skills live under the sandbox state dir and are mounted over
    // an empty scaffold inside the workspace, so the session root alone only
    // finds the empty mountpoint. No container is registered (as right after a
    // deploy recreates sandboxes), so the derived mapping must name the same
    // skills workspace the runtime would mount.
    useSandboxedSession(workspaceRoot);
    const cfg = hoisted.loadSessionEntry().cfg;
    const { skillsWorkspaceDir } = resolveSandboxWorkspaceLayoutPaths({
      cfg: resolveSandboxConfigForAgent(cfg, "main"),
      rawSessionKey: "agent:main:main",
      agentId: "main",
      workspaceDir: workspaceRoot,
    });
    try {
      writeWorkspaceFile(skillsWorkspaceDir, "skills/publish/SKILL.md", "# Publish\n");
      fs.mkdirSync(path.join(workspaceRoot, ".openclaw/sandbox-skills/skills"), {
        recursive: true,
      });
      const skillPath = "/workspace/.openclaw/sandbox-skills/skills/publish/SKILL.md";
      mockVisibleMessages([assistantToolCall("read", { path: skillPath })]);

      const payload = expectOkPayload(
        await invokeSessionFilesHandler("sessions.files.get", {
          sessionKey: "agent:main:main",
          path: skillPath,
        }),
      );

      expect(payload.file).toMatchObject({ path: skillPath, content: "# Publish\n" });
      expect(payload.file.hash).toBeUndefined();
      expect(payload.file.workspacePath).toBeUndefined();
    } finally {
      fs.rmSync(path.dirname(path.dirname(skillsWorkspaceDir)), { recursive: true, force: true });
    }
  });

  it("does not serve a custom bind outside the session root", async () => {
    // Custom bind sources are daemon-host paths; a same-named Gateway-local
    // directory is not guaranteed to be what the container sees.
    const bindRoot = fs.mkdtempSync(path.join(path.dirname(workspaceRoot), "openclaw-bind-"));
    try {
      writeWorkspaceFile(bindRoot, "note.md", "# Daemon host\n");
      useSandboxedSession(workspaceRoot, { binds: [`${bindRoot}:/data:ro`] });

      const error = expectError(
        await invokeSessionFilesHandler("sessions.files.get", {
          sessionKey: "agent:main:main",
          path: "/data/note.md",
        }),
      );

      expect(error).toMatchObject({ details: { type: "session_file_not_found" } });
    } finally {
      fs.rmSync(bindRoot, { recursive: true, force: true });
    }
  });

  it("leaves container paths unresolved for an unsandboxed agent", async () => {
    const error = expectError(
      await invokeSessionFilesHandler("sessions.files.get", {
        sessionKey: "agent:main:main",
        path: "/workspace/src/readme.md",
      }),
    );

    expect(error).toMatchObject({ details: { type: "session_file_not_found" } });
  });
});
