import { Type } from "typebox";

// Loopback, or a private IPv4 literal (RFC 1918 and the 100.64/10 range Tailscale uses)
// for a System One server on another machine in the operator's own network, such as
// Ollama's /v1/systemone on a GPU box. Literal dotted quads only: no hostnames, so DNS
// cannot move the endpoint, and no leading zeros, which URL parsing reads as octal.
const LOCAL_BASE_URL_PATTERN =
  "^https?://(?:localhost|127\\.0\\.0\\.1|\\[::1\\]|10\\.(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\\.(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\\.(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])|172\\.(?:1[6-9]|2[0-9]|3[01])\\.(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\\.(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])|192\\.168\\.(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\\.(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])|100\\.(?:6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\\.(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\\.(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9]))(?::[0-9]{1,5})?/?$";
const localBaseUrlPattern = new RegExp(LOCAL_BASE_URL_PATTERN);
// Ollama tags use name:tag, so local model names admit a colon.
const LOCAL_MODEL_PATTERN = "^[a-zA-Z0-9._/:-]+$";
const localModelPattern = new RegExp(LOCAL_MODEL_PATTERN);
export const ConfigSchema = Type.Object(
  {
    baseUrl: Type.Optional(Type.String({ maxLength: 128, pattern: LOCAL_BASE_URL_PATTERN })),
    apiKey: Type.Optional(
      Type.Object(
        {
          source: Type.Union([
            Type.Literal("env"),
            Type.Literal("store"),
            Type.Literal("file"),
            Type.Literal("exec"),
          ]),
          provider: Type.String({ minLength: 1, maxLength: 128 }),
          id: Type.String({ minLength: 1, maxLength: 1024 }),
        },
        { additionalProperties: false },
      ),
    ),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 60000, default: 30000 })),
    localModel: Type.Optional(
      Type.String({ minLength: 1, maxLength: 128, pattern: LOCAL_MODEL_PATTERN }),
    ),
  },
  { additionalProperties: false },
);

export type RuntimeConfig = {
  apiKey?: string;
  baseUrl?: string;
  /** Model name sent to a local server that routes by name (Ollama), in place of kev-latest. */
  localModel?: string;
  timeoutMs: number;
};

/** A configured endpoint grants access to one loopback or private-IP origin, never a hostname. */
export function localBaseUrl(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    if (typeof value !== "string" || value !== value.trim() || !localBaseUrlPattern.test(value)) {
      throw new Error();
    }
    return new URL(value).origin;
  } catch {
    throw new Error(
      "Invalid TypeSafe baseUrl; use an http(s) loopback or private IPv4 origin without a path, credentials, query, or fragment.",
    );
  }
}

/** Validate runtime settings and recognize materialized credentials without resolving inputs. */
export function runtimeConfig(config: Record<string, unknown> | undefined): RuntimeConfig {
  const baseUrl = localBaseUrl(config?.baseUrl);
  const timeoutMs = config?.timeoutMs ?? 30000;
  if (
    typeof timeoutMs !== "number" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1000 ||
    timeoutMs > 60000
  ) {
    throw new Error("Invalid TypeSafe configuration; check plugin Settings.");
  }
  const localModel = config?.localModel;
  if (
    localModel !== undefined &&
    (typeof localModel !== "string" ||
      localModel.length > 128 ||
      !localModelPattern.test(localModel))
  ) {
    throw new Error("Invalid TypeSafe localModel; use a model name such as tev1:4b.");
  }
  if (baseUrl) {
    return { baseUrl, ...(localModel ? { localModel } : {}), timeoutMs };
  }
  const key = config?.apiKey;
  return { apiKey: typeof key === "string" && key.trim() ? key : undefined, timeoutMs };
}
