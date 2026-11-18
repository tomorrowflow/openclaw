import { hashTextSha256 } from "./hash.js";
import type { SandboxBrowserConfig, SandboxDockerConfig, SandboxWorkspaceAccess } from "./types.js";

/**
 * Stable sandbox config hashing for container reuse decisions.
 *
 * Undefined values and object key order are normalized so semantically equal
 * configs keep the same hash while security epoch changes force recreation.
 */
export const SANDBOX_DOCKER_EXPLICIT_ENV_POLICY_EPOCH = "explicit-config-env-v1";

type SandboxHashInput = {
  docker: SandboxDockerConfig;
  dockerEnvPolicyEpoch?: string;
  workspaceAccess: SandboxWorkspaceAccess;
  workspaceDir: string;
  agentWorkspaceDir: string;
  mountFormatVersion: number;
  createArgsEpoch: string;
  managedMounts?: readonly string[];
};

type SandboxBrowserHashInput = SandboxHashInput & {
  browser: Pick<
    SandboxBrowserConfig,
    | "cdpPort"
    | "cdpSourceRange"
    | "vncPort"
    | "noVncPort"
    | "headless"
    | "noVncEnabled"
    | "autoStartTimeoutMs"
  >;
  securityEpoch: string;
};

function normalizeForHash(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeForHash).filter((item): item is unknown => item !== undefined);
  }
  if (value && typeof value === "object") {
    // Sort object keys recursively so JSON serialization is deterministic.
    const entries = Object.entries(value).toSorted(([a], [b]) => a.localeCompare(b));
    const normalized: Record<string, unknown> = {};
    for (const [key, entryValue] of entries) {
      const next = normalizeForHash(entryValue);
      if (next !== undefined) {
        normalized[key] = next;
      }
    }
    return normalized;
  }
  return value;
}

/** Computes the sandbox container config hash. */
export function computeSandboxConfigHash(input: SandboxHashInput): string {
  return hashTextSha256(JSON.stringify(normalizeForHash(input)));
}

const CONFIG_HASH_PART_LENGTH = 12;

/**
 * Short per-input digests recorded beside the config hash, so a replacement can name
 * which inputs changed. Docker settings and env split per key; values stay hashed.
 */
export function computeSandboxConfigHashParts(input: SandboxHashInput): Record<string, string> {
  const normalized = normalizeForHash(input) as Record<string, unknown>;
  const parts: Record<string, string> = {};
  const add = (key: string, value: unknown) => {
    parts[key] = hashTextSha256(JSON.stringify(value)).slice(0, CONFIG_HASH_PART_LENGTH);
  };
  for (const [key, value] of Object.entries(normalized)) {
    if (key !== "docker" || !value || typeof value !== "object") {
      add(key, value);
      continue;
    }
    for (const [dockerKey, dockerValue] of Object.entries(value)) {
      if (dockerKey === "env" && dockerValue && typeof dockerValue === "object") {
        for (const [name, envValue] of Object.entries(dockerValue)) {
          add(`docker.env.${name}`, envValue);
        }
      } else {
        add(`docker.${dockerKey}`, dockerValue);
      }
    }
  }
  return parts;
}

/** Names the inputs whose digests differ; undefined when the previous parts are unknown. */
export function diffSandboxConfigHashParts(
  previous: Record<string, string> | undefined,
  next: Record<string, string>,
): string[] | undefined {
  if (!previous) {
    return undefined;
  }
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  return [...keys].filter((key) => previous[key] !== next[key]).toSorted();
}

/** Computes the browser-enabled sandbox container config hash. */
export function computeSandboxBrowserConfigHash(input: SandboxBrowserHashInput): string {
  return computeSandboxConfigHash(input);
}
