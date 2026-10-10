import type { WorkboardCommentSource } from "@openclaw/workboard-contract";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

export function normalizeBoundedString(
  value: unknown,
  fallback: string | undefined,
  maxLength: number,
  fieldName: string,
): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return fallback;
  }
  if (normalized.length > maxLength) {
    throw new Error(
      `${fieldName} must be ${maxLength} characters or fewer (got ${normalized.length}).`,
    );
  }
  return normalized;
}

const COMMENT_AGENT_SOURCE_PATTERN = /^agent:([\w.-]{1,64})$/;

/** Keeps a recorded comment source only in its two valid shapes. */
export function normalizeCommentSource(value: unknown): WorkboardCommentSource | undefined {
  if (value === "operator") {
    return value;
  }
  const agentId =
    typeof value === "string" ? COMMENT_AGENT_SOURCE_PATTERN.exec(value)?.[1] : undefined;
  return agentId ? `agent:${agentId}` : undefined;
}
