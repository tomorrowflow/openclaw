/** Guards sandbox use against unresolved runtime SecretRefs. */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { coerceSecretRef } from "../../config/types.secrets.js";
import { getContainerEnvFileEntryIssue } from "../../infra/container-env-file.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { secretRefKey } from "../../secrets/ref-contract.js";
import { SecretSurfaceUnavailableError } from "../../secrets/runtime-degraded-state.js";
import {
  assertRuntimeSandboxSecretOwnerAvailable,
  runtimeSandboxSecretOwnerId,
} from "../../secrets/runtime-sandbox-secret-owner.js";
import { listAgentEntriesWithSource, resolveAgentConfig } from "../agent-scope-config.js";
import type { SandboxScope } from "./types.js";

const SSH_SECRET_KEYS = ["identityData", "certificateData", "knownHostsData"] as const;

type SandboxSecretField = { key: string; path: string; value: unknown };

function resolveAgentConfigPath(config: OpenClawConfig, agentId: string): string | undefined {
  const normalizedAgentId = normalizeAgentId(agentId);
  const source = listAgentEntriesWithSource(config).find(
    ({ entry }) => normalizeAgentId(entry.id) === normalizedAgentId,
  )?.source;
  if (!source) {
    return undefined;
  }
  return source.kind === "entries" ? `agents.entries.${source.key}` : `agents.list.${source.index}`;
}

/**
 * Rejects cold or unmaterialized sandbox secrets before any host SSH fallback
 * or container creation is possible. Lifecycle-only callers (inspect, remove)
 * skip container env, which they never forward.
 */
export function assertSandboxSecretOwnerAvailable(params: {
  config?: OpenClawConfig;
  scope: SandboxScope;
  agentId?: string;
  backend: string;
  includeContainerEnv: boolean;
}): void {
  if (params.agentId) {
    assertRuntimeSandboxSecretOwnerAvailable(params.agentId);
  }
  if (!params.config) {
    return;
  }

  const defaultsSandbox = params.config.agents?.defaults?.sandbox;
  const agentSandbox =
    params.agentId && params.scope !== "shared"
      ? resolveAgentConfig(params.config, params.agentId)?.sandbox
      : undefined;
  const agentPath =
    agentSandbox && params.agentId
      ? resolveAgentConfigPath(params.config, params.agentId)
      : undefined;
  const fields: SandboxSecretField[] = [];
  const collect = (
    surface: string,
    keys: Iterable<string>,
    defaults: Readonly<Record<string, unknown>> | undefined,
    override: Readonly<Record<string, unknown>> | undefined,
  ) => {
    for (const key of keys) {
      const usesAgentValue = Boolean(override && Object.hasOwn(override, key));
      if (!usesAgentValue && !(defaults && Object.hasOwn(defaults, key))) {
        continue;
      }
      fields.push({
        key,
        path:
          usesAgentValue && agentPath
            ? `${agentPath}.sandbox.${surface}.${key}`
            : `agents.defaults.sandbox.${surface}.${key}`,
        value: usesAgentValue ? override?.[key] : defaults?.[key],
      });
    }
  };
  if (params.backend === "ssh") {
    collect("ssh", SSH_SECRET_KEYS, defaultsSandbox?.ssh, agentSandbox?.ssh);
  }
  const envFieldStart = fields.length;
  if (params.includeContainerEnv) {
    const defaultsEnv = defaultsSandbox?.docker?.env;
    const agentEnv = agentSandbox?.docker?.env;
    collect(
      "docker.env",
      new Set([...Object.keys(defaultsEnv ?? {}), ...Object.keys(agentEnv ?? {})]),
      defaultsEnv,
      agentEnv,
    );
  }

  const unresolved = fields.flatMap(({ path, value }) => {
    const ref = coerceSecretRef(value, params.config?.secrets?.defaults);
    return ref ? [{ path, refKey: secretRefKey(ref) }] : [];
  });
  if (unresolved.length > 0) {
    throw new SecretSurfaceUnavailableError({
      ownerKind: "capability",
      ownerId: runtimeSandboxSecretOwnerId(params.agentId ?? "shared"),
      state: "unavailable",
      paths: unresolved.map((entry) => entry.path),
      refKeys: unresolved.map((entry) => entry.refKey),
      reason: "configured sandbox secret reference was not materialized",
    });
  }

  // Config validation rejects multiline literals; a resolved SecretRef is the
  // first point where its value can be checked against the env-file transport.
  if (params.backend !== "docker" && params.backend !== "podman") {
    return;
  }
  for (const { key, path, value } of fields.slice(envFieldStart)) {
    if (typeof value === "string" && getContainerEnvFileEntryIssue(key, value)) {
      throw new Error(
        `${path} resolved to a value the ${params.backend === "podman" ? "Podman" : "Docker"} sandbox cannot pass: container env-file values must be single-line and free of NUL bytes. Store a single-line value, or deliver multiline material through a mounted file or custom image.`,
      );
    }
  }
}
