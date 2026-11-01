import { isNonSecretApiKeyMarker } from "../agents/model-auth-markers.js";
import { resolveConfigSecretRef } from "../config/resolution-facts.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { coerceSecretRef, type SecretRef } from "../config/types.secrets.js";
import { isLikelySensitiveModelProviderHeaderName } from "./model-provider-header-policy.js";
import { isSensitiveEnvName } from "./secret-env-name.js";
import { hasConfiguredPlaintextSecretValue } from "./secret-value.js";
import type { DiscoveredConfigSecretTarget } from "./target-registry-types.js";

// Container env also carries ordinary settings; only credential-named literals are residue.
const SANDBOX_DOCKER_ENV_TARGET_IDS = new Set([
  "agents.defaults.sandbox.docker.env.*",
  "agents.entries.*.sandbox.docker.env.*",
]);

/** Classifies authored config credentials for Doctor and secrets audit. */
export function classifyConfigSecretTarget(
  config: OpenClawConfig,
  target: DiscoveredConfigSecretTarget,
): { ref: SecretRef | null; plaintext: boolean } {
  if (!target.entry.includeInAudit) {
    return { ref: null, plaintext: false };
  }
  const defaults = config.secrets?.defaults;
  const inlineRef = resolveConfigSecretRef({
    config,
    path: target.path,
    value: target.value,
    defaults,
    includeResolved: true,
  });
  return {
    ref: coerceSecretRef(target.refValue, defaults) ?? inlineRef,
    plaintext:
      inlineRef === null &&
      hasConfiguredPlaintextSecretValue(target.value, target.entry.expectedResolvedValue) &&
      !(
        target.entry.id === "models.providers.*.headers.*" &&
        !isLikelySensitiveModelProviderHeaderName(target.pathSegments.at(-1) ?? "")
      ) &&
      !(
        SANDBOX_DOCKER_ENV_TARGET_IDS.has(target.entry.id) &&
        !isSensitiveEnvName(target.pathSegments.at(-1) ?? "")
      ) &&
      !(
        target.entry.id === "models.providers.*.apiKey" &&
        typeof target.value === "string" &&
        isNonSecretApiKeyMarker(target.value)
      ),
  };
}
