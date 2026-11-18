// Sandboxed agents name files by container path, so the Gateway file surface
// must translate them through the sandbox mount table before serving them.
// The session row, transcript, sandbox registry and mount selection are real;
// only the container engine stays untouched (these paths never need one).
import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { resolveSandboxConfigForAgent } from "../../agents/sandbox/config.js";
import * as engine from "../../agents/sandbox/container-engine.js";
import { removeRegistryEntry, updateRegistry } from "../../agents/sandbox/registry.js";
import { resolveSandboxWorkspaceLayoutPaths } from "../../agents/sandbox/shared.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { createSessionEntryWithTranscript } from "../../config/sessions/session-accessor.entry-mutation.js";
import { appendTranscriptMessage } from "../../config/sessions/session-accessor.sqlite-transcript-write.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "../server-methods.js";
import { sessionsFilesHandlers } from "./sessions-files.js";
import {
  assistantToolCall,
  createSessionFileDownloadClient,
  expectError,
  expectOkPayload,
  hashContent,
  writeWorkspaceFile,
} from "./sessions-files.test-support.js";

type SandboxOptions = { mode?: "all" | "non-main"; binds?: string[] };

it("serves sandbox container paths through the recorded mount table", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const root = state.workspaceDir;
    writeWorkspaceFile(root, "src/readme.md", "# Read me\n");
    writeWorkspaceFile(root, "ui/chat.ts", "export const chat = true;\n");
    writeWorkspaceFile(root, "ui/vite.config.ts", "export default {};\n");
    let cfg: OpenClawConfig = {};
    const configure = (sandbox?: SandboxOptions) => {
      cfg = {
        agents: {
          defaults: sandbox
            ? {
                sandbox: {
                  mode: sandbox.mode ?? "all",
                  workspaceAccess: "rw",
                  workspaceRoot: state.path("sandboxes"),
                  ...(sandbox.binds ? { docker: { binds: sandbox.binds } } : {}),
                },
              }
            : {},
          entries: { main: { workspace: root } },
        },
      };
      setRuntimeConfigSnapshot(cfg);
    };
    // No container engine answers: previews must not depend on a live container.
    vi.spyOn(engine, "execContainer").mockRejectedValue(new Error("No container engine"));
    let sessionCount = 0;
    const createSession = async (
      sessionKey: string,
      touched: Array<ReturnType<typeof assistantToolCall>> = [],
    ) => {
      const sessionId = `sandbox-paths-${String(++sessionCount)}`;
      const scope = { agentId: "main", sessionKey, sessionId };
      await createSessionEntryWithTranscript(scope, () => ({
        ok: true,
        entry: { sessionId, updatedAt: 1, spawnedCwd: root },
      }));
      const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
      for (const message of touched) {
        await appendTranscriptMessage({ ...scope, storePath }, { message });
      }
      return sessionKey;
    };
    using download = createSessionFileDownloadClient();
    const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
    const request = async (operation: "list" | "get" | "set", params: Record<string, unknown>) => {
      const method = `sessions.files.${operation}`;
      const respond = vi.fn();
      await handleGatewayRequest({
        req: { type: "req", id: method, method, params },
        client: download.client,
        context,
        respond,
        isWebchatConnect: () => false,
        extraHandlers: sessionsFilesHandlers,
      });
      return respond.mock.calls.map(([ok, payload, error]) => ({ ok, payload, error }));
    };
    const get = async (sessionKey: string, file: string) => {
      const calls = await request("get", { sessionKey, path: file });
      expect(calls[0]?.error).toBeUndefined();
      return expectOkPayload(calls).file;
    };
    const notFound = async (sessionKey: string, file: string) =>
      expect(expectError(await request("get", { sessionKey, path: file }))).toMatchObject({
        details: { type: "session_file_not_found" },
      });

    configure({});
    const main = await createSession("agent:main:main");

    // A workspace file the agent named by its container path, with no container
    // registered (as right after a deploy recreates sandboxes).
    expect(await get(main, "/workspace/src/readme.md")).toMatchObject({
      content: "# Read me\n",
      workspacePath: "src/readme.md",
    });

    // A file the transcript recorded by container path previews and lists.
    const touched = await createSession("agent:main:touched", [
      assistantToolCall("read", { path: "/workspace/src/readme.md" }),
      assistantToolCall("edit", { path: "/workspace/ui/chat.ts" }),
    ]);
    expect(await get(touched, "/workspace/src/readme.md")).toMatchObject({
      content: "# Read me\n",
      workspacePath: "src/readme.md",
    });
    const listed = expectOkPayload(await request("list", { sessionKey: touched }));
    expect(
      listed.files.map((file: { workspacePath?: string; missing?: boolean }) => [
        file.workspacePath,
        file.missing,
      ]),
    ).toEqual([
      ["ui/chat.ts", false],
      ["src/readme.md", false],
    ]);
    expect(
      listed.browser?.entries.find((entry: { path: string }) => entry.path === "ui"),
    ).toMatchObject({ sessionKind: "modified" });

    // Browsing the directory a revealed container path points at.
    const browsed = expectOkPayload(
      await request("list", { sessionKey: main, path: "/workspace/src" }),
    );
    expect(browsed.browser?.path).toBe("src");
    expect(browsed.browser?.entries.map((entry: { path: string }) => entry.path)).toContain(
      "src/readme.md",
    );

    // Saving a file opened by container path writes the same host file.
    const saved = expectOkPayload(
      await request("set", {
        sessionKey: main,
        path: "/workspace/ui/vite.config.ts",
        content: "export default { sandbox: true };\n",
        expectedHash: hashContent("export default {};\n"),
      }),
    );
    expect(saved.file.workspacePath).toBe("ui/vite.config.ts");
    expect(fs.readFileSync(path.join(root, "ui/vite.config.ts"), "utf8")).toBe(
      "export default { sandbox: true };\n",
    );

    // A container path no mount maps into this workspace stays refused.
    await notFound(main, "/etc/hostname");

    // A nested mount resolves to its own host root, not the workspace prefix.
    // Both directories exist, so a string strip would serve the wrong file.
    writeWorkspaceFile(root, "exchange/note.md", "# Exchanged\n");
    writeWorkspaceFile(root, "shared/note.md", "# Not the mount source\n");
    configure({ binds: [`${path.join(root, "exchange")}:/workspace/shared`] });
    expect(await get(main, "/workspace/shared/note.md")).toMatchObject({
      content: "# Exchanged\n",
      workspacePath: "exchange/note.md",
    });

    // The registered container's recorded mounts win over config that has
    // moved on: config now names `exchange`, the container still mounts `shared`.
    // Its engine cannot be inspected, so live backing proof is unavailable.
    const layout = resolveSandboxWorkspaceLayoutPaths({
      cfg: resolveSandboxConfigForAgent(cfg, "main"),
      rawSessionKey: main,
      agentId: "main",
      workspaceDir: root,
    });
    await updateRegistry({
      containerName: "openclaw-sbx-recorded",
      backendId: "docker",
      sessionKey: layout.scopeKey,
      workspaceDir: root,
      image: "fixture",
      createdAtMs: 1,
      lastUsedAtMs: 1,
      mounts: [
        { hostPath: root, containerPath: "/workspace" },
        { hostPath: path.join(root, "shared"), containerPath: "/workspace/shared" },
      ],
    });
    expect(await get(main, "/workspace/shared/note.md")).toMatchObject({
      content: "# Not the mount source\n",
      workspacePath: "shared/note.md",
    });
    // A deploy removes the container; the mapping derives from config again.
    await removeRegistryEntry("openclaw-sbx-recorded");

    // Custom bind sources are daemon-host paths and are never served.
    const bindRoot = state.path("bind-source");
    writeWorkspaceFile(bindRoot, "note.md", "# Daemon host\n");
    configure({ binds: [`${bindRoot}:/data:ro`] });
    const unregistered = await createSession("agent:main:unregistered");
    await notFound(unregistered, "/data/note.md");

    // Materialized skills live under the sandbox state dir, outside the session
    // root; the derived mapping names the skills workspace the runtime mounts.
    configure({});
    const skillsKey = await createSession("agent:main:skills");
    const { skillsWorkspaceDir } = resolveSandboxWorkspaceLayoutPaths({
      cfg: resolveSandboxConfigForAgent(cfg, "main"),
      rawSessionKey: skillsKey,
      agentId: "main",
      workspaceDir: root,
    });
    writeWorkspaceFile(skillsWorkspaceDir, "skills/publish/SKILL.md", "# Publish\n");
    fs.mkdirSync(path.join(root, ".openclaw/sandbox-skills/skills"), { recursive: true });
    const skillPath = "/workspace/.openclaw/sandbox-skills/skills/publish/SKILL.md";
    const skill = await get(skillsKey, skillPath);
    expect(skill).toMatchObject({ path: skillPath, content: "# Publish\n" });
    expect(skill.hash).toBeUndefined();
    expect(skill.workspacePath).toBeUndefined();

    // "non-main" runs the agent's own main session on the host, where
    // /workspace/... is a literal host path; other sessions stay sandboxed.
    configure({ mode: "non-main" });
    await notFound(main, "/workspace/src/readme.md");
    const sidequest = await createSession("agent:main:sidequest");
    expect((await get(sidequest, "/workspace/src/readme.md")).workspacePath).toBe("src/readme.md");

    // An unsandboxed agent never translates.
    configure();
    await notFound(main, "/workspace/src/readme.md");
  });
});
