import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { resolveSandboxConfigForAgent } from "../../agents/sandbox/config.js";
import { deriveSandboxContainerMounts } from "../../agents/sandbox/fs-paths.js";
import {
  readRegisteredSandboxRuntimeIds,
  readRegistryEntry,
} from "../../agents/sandbox/registry.js";
import { resolvePreparedSandboxRuntimeStatus } from "../../agents/sandbox/runtime-status.js";
import { resolveSandboxWorkspaceLayoutPaths } from "../../agents/sandbox/shared.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SessionSandboxPaths } from "./session-file-read.js";

/**
 * Sandboxed agents name files by container path, so browsing needs the mapping
 * the container was built from to resolve them against this root.
 *
 * The agent's `mode` is not the signal for whether to translate: under
 * "non-main" the agent's own main session runs on the host, where
 * `/workspace/...` is a literal host path and translating it would resolve an
 * unrelated file. Ask the runtime-status owner about this exact session.
 *
 * The registered container's own recorded mapping wins over one derived from
 * current configuration, which can already describe a container that has not
 * been recreated yet — deriving there can resolve a real but wrong file, since
 * both the old and new mapping can land inside this root.
 */
export async function resolveSessionSandboxPaths(
  cfg: OpenClawConfig,
  agentId: string,
  sessionKey: string,
  root: string | undefined,
  entry: Partial<InternalSessionEntry> | undefined,
): Promise<SessionSandboxPaths | undefined> {
  if (!root) {
    return undefined;
  }
  // The loaded entry is this session's canonical row; classify it without another read.
  const status = resolvePreparedSandboxRuntimeStatus({
    cfg,
    agentId,
    sessionKey,
    preparedSessionEntry: entry ?? null,
  });
  if (!status.sandboxed) {
    return undefined;
  }
  const sandbox = resolveSandboxConfigForAgent(cfg, agentId);
  const agentWorkspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  // A session created with sandbox "required" runs at the access the status
  // owner downgraded it to, and that decides which mounts it received.
  const workspaceAccess = status.sandboxRequired ? status.workspaceAccess : sandbox.workspaceAccess;
  // The layout owner names both the registry scope and the materialized skills
  // workspace; without the latter a derived mapping points the skills mount at
  // the empty scaffold inside the workspace instead of the copy it received.
  const layout = resolveSandboxWorkspaceLayoutPaths({
    cfg: { ...sandbox, workspaceAccess },
    rawSessionKey: sessionKey,
    agentId,
    ...(status.sandboxRequired && status.isolationSubject
      ? { isolationSubject: status.isolationSubject }
      : {}),
    workspaceDir: agentWorkspaceDir,
  });
  const recorded = await readRecordedSandboxMounts(sandbox.backend, layout.scopeKey);
  if (recorded) {
    return { mounts: recorded };
  }
  return {
    mounts: deriveSandboxContainerMounts({
      workspaceDir: root,
      agentWorkspaceDir,
      skillsWorkspaceDir: layout.skillsWorkspaceDir,
      workspaceAccess,
      workdir: sandbox.docker.workdir,
      ...(sandbox.docker.binds ? { binds: sandbox.docker.binds } : {}),
    }),
  };
}

/** Reads the mapping the newest container registered for this sandbox scope received. */
async function readRecordedSandboxMounts(
  backendId: ReturnType<typeof resolveSandboxConfigForAgent>["backend"],
  scopeKey: string,
) {
  try {
    const [containerName] = await readRegisteredSandboxRuntimeIds({ backendId, scopeKey });
    if (!containerName) {
      return undefined;
    }
    const entry = await readRegistryEntry(containerName);
    return entry?.mounts?.length ? entry.mounts : undefined;
  } catch {
    // Browsing must not fail because the sandbox registry is unreadable; the
    // derived mapping still serves the common case.
    return undefined;
  }
}
