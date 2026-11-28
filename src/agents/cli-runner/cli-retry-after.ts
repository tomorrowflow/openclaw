import { formatErrorMessage } from "../../infra/errors.js";
import { resolveRetryAfterMs } from "../failover/retry-evidence.js";
import { parseProviderUsageLimit } from "../failover/usage-limit.js";

/**
 * Claude names its usage-window reset ("resets 11:10pm (Europe/Berlin)")
 * instead of a retry delay. Without it the limited account stays first and
 * every later run fails on it until the reset; with it the account cools
 * down and the next run takes the agent's next account.
 */
export function resolveCliRetryAfterMs(error: unknown): number | undefined {
  const message = formatErrorMessage(error);
  const now = Date.now();
  const retryAfterMs = resolveRetryAfterMs(message, now, error);
  if (retryAfterMs !== undefined) {
    return retryAfterMs;
  }
  const resetsAt = parseProviderUsageLimit(message, now)?.resetsAt;
  return resetsAt === undefined ? undefined : resetsAt - now;
}
