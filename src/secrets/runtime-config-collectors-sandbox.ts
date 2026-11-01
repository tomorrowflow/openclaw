/** Collects agent-scoped sandbox SecretRefs (SSH material, container env) during runtime preparation. */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { listAgentEntriesWithSource, resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import { resolveSandboxScope } from "../agents/sandbox/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { appendConfigPathSegment } from "../shared/dot-path.js";
import { runtimeSandboxSecretOwnerId } from "./runtime-sandbox-secret-owner.js";
import {
  createConfigSecretInputCollector,
  type ResolverContext,
  type SecretAssignmentOwner,
  type SecretDefaults,
} from "./runtime-shared.js";
import { isRecord } from "./shared.js";

type SandboxSettings = { backend: string; mode: string };

type SandboxSecretSurface = {
  /** Config path below `<agent>.sandbox`. */
  path: string;
  read: (sandbox: Record<string, unknown> | undefined) => Record<string, unknown> | undefined;
  keys: (
    defaults: Record<string, unknown> | undefined,
    override: Record<string, unknown> | undefined,
  ) => readonly string[];
  isActive: (settings: SandboxSettings) => boolean;
  inactiveReason: string;
  sharedScopeReason: string;
};

const SANDBOX_SECRET_SURFACES: readonly SandboxSecretSurface[] = [
  {
    path: "ssh",
    read: (sandbox) => (isRecord(sandbox?.ssh) ? sandbox.ssh : undefined),
    keys: () => ["identityData", "certificateData", "knownHostsData"],
    // Existing registry entries remain inspectable/removable after an agent or its
    // sandbox is disabled, so SSH lifecycle credentials stay materialized while
    // SSH remains the configured backend.
    isActive: ({ backend }) => backend === "ssh",
    inactiveReason: "sandbox SSH backend is not configured for this agent.",
    sharedScopeReason: "shared sandbox scope ignores agent SSH overrides.",
  },
  {
    path: "docker.env",
    read: (sandbox) => {
      const docker = isRecord(sandbox?.docker) ? sandbox.docker : undefined;
      return isRecord(docker?.env) ? docker.env : undefined;
    },
    keys: (defaults, override) => [
      ...new Set([...Object.keys(defaults ?? {}), ...Object.keys(override ?? {})]),
    ],
    // Every sandbox backend forwards docker.env into the runtime it creates.
    isActive: ({ mode }) => mode !== "off",
    inactiveReason: "sandbox mode is off for this agent.",
    sharedScopeReason: "shared sandbox scope ignores agent docker.env overrides.",
  },
];

function sandboxSecretOwner(agentId: string, contract: unknown): SecretAssignmentOwner {
  return {
    ownerKind: "capability",
    ownerId: runtimeSandboxSecretOwnerId(agentId),
    requiredForGateway: false,
    disposition: "isolate",
    contract,
  };
}

function readSandboxSettings(
  sandbox: Record<string, unknown> | undefined,
  fallback?: SandboxSettings,
): SandboxSettings {
  return {
    backend: normalizeOptionalLowercaseString(sandbox?.backend) ?? fallback?.backend ?? "docker",
    mode: typeof sandbox?.mode === "string" ? sandbox.mode : (fallback?.mode ?? "off"),
  };
}

/** Collects sandbox secret inputs once for every agent whose current sandbox can consume them. */
export function collectAgentSandboxAssignments(params: {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
  agentId?: string;
}): void {
  const collect = createConfigSecretInputCollector(params);
  const rawAgents: unknown = params.config.agents;
  const agents = isRecord(rawAgents) ? rawAgents : undefined;
  if (!agents) {
    return;
  }
  const defaultsAgent = isRecord(agents.defaults) ? agents.defaults : undefined;
  const defaultsSandbox = isRecord(defaultsAgent?.sandbox) ? defaultsAgent.sandbox : undefined;
  const defaultsSettings = readSandboxSettings(defaultsSandbox);
  const activeDefaultPaths = new Set<string>();
  const seenAgentIds = new Set<string>();

  for (const { entry: rawAgent, source } of listAgentEntriesWithSource(params.config)) {
    const rawAgentRecord: unknown = rawAgent;
    if (!isRecord(rawAgentRecord)) {
      continue;
    }
    const agentId = normalizeAgentId(rawAgent.id);
    if (seenAgentIds.has(agentId)) {
      continue;
    }
    seenAgentIds.add(agentId);
    const agentPath =
      source.kind === "entries"
        ? appendConfigPathSegment("agents.entries", source.key)
        : `agents.list[${source.index}]`;

    const sandbox = isRecord(rawAgentRecord.sandbox) ? rawAgentRecord.sandbox : undefined;
    const settings = readSandboxSettings(sandbox, defaultsSettings);
    const scope = resolveSandboxScope({
      scope:
        typeof sandbox?.scope === "string"
          ? (sandbox.scope as "agent" | "session" | "shared")
          : typeof defaultsSandbox?.scope === "string"
            ? (defaultsSandbox.scope as "agent" | "session" | "shared")
            : undefined,
    });
    const owner = sandboxSecretOwner(agentId, {
      defaults: defaultsSandbox,
      override: sandbox,
      agentEnabled: rawAgentRecord["enabled"],
    });

    for (const surface of SANDBOX_SECRET_SURFACES) {
      const active = surface.isActive(settings);
      const defaultsTarget = surface.read(defaultsSandbox);
      const agentTarget = surface.read(sandbox);
      for (const key of surface.keys(defaultsTarget, agentTarget)) {
        const keyPath = appendConfigPathSegment(surface.path, key);
        if (agentTarget && Object.hasOwn(agentTarget, key)) {
          collect(agentTarget, key, `${agentPath}.sandbox.${keyPath}`, {
            active: scope !== "shared" && active,
            inactiveReason: scope === "shared" ? surface.sharedScopeReason : surface.inactiveReason,
            owner,
          });
          if (scope !== "shared") {
            continue;
          }
        }
        if (!defaultsTarget || !Object.hasOwn(defaultsTarget, key) || !active) {
          continue;
        }
        const defaultsPath = `agents.defaults.sandbox.${keyPath}`;
        activeDefaultPaths.add(defaultsPath);
        collect(defaultsTarget, key, defaultsPath, { active: true, owner });
      }
    }
  }

  // Unlisted agents and stale registry entries still resolve through defaults,
  // even when every current list entry overrides a value. Resolving the default
  // agent throws for multi-agent rosters, so only an active ref resolves it.
  let fallbackOwner: SecretAssignmentOwner | undefined;
  const resolveFallbackOwner = () =>
    (fallbackOwner ??= sandboxSecretOwner(
      params.agentId === undefined
        ? resolveDefaultAgentId(params.config)
        : normalizeAgentId(params.agentId),
      { defaults: defaultsSandbox },
    ));
  for (const surface of SANDBOX_SECRET_SURFACES) {
    const defaultsTarget = surface.read(defaultsSandbox);
    if (!defaultsTarget) {
      continue;
    }
    for (const key of surface.keys(defaultsTarget, undefined)) {
      const defaultsPath = `agents.defaults.sandbox.${appendConfigPathSegment(surface.path, key)}`;
      if (
        !Object.hasOwn(defaultsTarget, key) ||
        typeof defaultsTarget[key] === "string" ||
        activeDefaultPaths.has(defaultsPath)
      ) {
        continue;
      }
      const active = surface.isActive(defaultsSettings);
      collect(defaultsTarget, key, defaultsPath, {
        active,
        inactiveReason: `no enabled agent uses ${defaultsPath}.`,
        ...(active ? { owner: resolveFallbackOwner() } : {}),
      });
    }
  }
}
