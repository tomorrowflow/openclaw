import type { WorkboardLaunchState, WorkboardStartRequest } from "@openclaw/workboard-contract";
import {
  isRecord,
  normalizeBoundedOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

// Host-issued automation run state: only trusted store writes may set it, and
// a stored value that fails these shapes is dropped rather than repaired.

function normalizeLaunchTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;
}

export function normalizeStartRequest(value: unknown): WorkboardStartRequest | undefined {
  const requestedAt = isRecord(value) ? normalizeLaunchTimestamp(value.requestedAt) : undefined;
  return requestedAt === undefined ? undefined : { requestedAt };
}

export function normalizeLaunchState(value: unknown): WorkboardLaunchState | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const requestedSessionKey = normalizeBoundedOptionalString(value.requestedSessionKey, 240);
  const provisionalRunId = normalizeBoundedOptionalString(value.provisionalRunId, 160);
  const preparedAt = normalizeLaunchTimestamp(value.preparedAt);
  if (!requestedSessionKey || !provisionalRunId || preparedAt === undefined) {
    return undefined;
  }
  const identity = { requestedSessionKey, provisionalRunId, preparedAt };
  if (value.phase === "prepared") {
    return { phase: "prepared", ...identity };
  }
  if (value.phase === "accepted") {
    const acceptedAt = normalizeLaunchTimestamp(value.acceptedAt);
    const acceptedSessionKey = normalizeBoundedOptionalString(value.acceptedSessionKey, 240);
    const acceptedRunId = normalizeBoundedOptionalString(value.acceptedRunId, 160);
    return acceptedAt === undefined || !acceptedSessionKey
      ? undefined
      : {
          phase: "accepted",
          ...identity,
          acceptedAt,
          acceptedSessionKey,
          ...(acceptedRunId ? { acceptedRunId } : {}),
        };
  }
  if (value.phase === "failed") {
    const failedAt = normalizeLaunchTimestamp(value.failedAt);
    const reason = normalizeBoundedOptionalString(value.reason, 800);
    return failedAt === undefined || !reason
      ? undefined
      : { phase: "failed", ...identity, failedAt, reason };
  }
  return undefined;
}
