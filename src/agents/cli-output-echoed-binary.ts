import { estimateBase64DecodedBytes } from "@openclaw/media-core/base64";
import { isRecord } from "@openclaw/normalization-core/record-coerce";

/** Drops Claude's echoed binary bytes before the record reaches tool-result and transcript consumers. */
export function normalizeClaudeCliStreamJsonRecord(parsed: Record<string, unknown>): void {
  if (parsed.type !== "user" || !isRecord(parsed.message)) {
    return;
  }
  // Claude echoes each payload twice, under `message` and under `tool_use_result`, so the
  // whole record is walked. The walk is iterative to stay stack-safe on deep records.
  const pending: unknown[] = [parsed];
  while (pending.length > 0) {
    const node = pending.pop();
    if (Array.isArray(node)) {
      for (const item of node) {
        pending.push(item);
      }
      continue;
    }
    if (!isRecord(node)) {
      continue;
    }
    const source = node.source;
    const data = isRecord(source) && source.type === "base64" ? source.data : undefined;
    if (
      typeof data === "string" &&
      isRecord(source) &&
      (node.type === "image" ||
        (node.type === "document" && source.media_type === "application/pdf"))
    ) {
      const { data: _omitted, ...rest } = source;
      node.source = rest;
      node.omitted = true;
      node.bytes = estimateBase64DecodedBytes(data);
    }
    const directBase64Outputs = [
      node.file,
      ...(Array.isArray(node.images) ? node.images : []),
      ...(Array.isArray(node.documents) ? node.documents : []),
    ];
    for (const output of directBase64Outputs) {
      if (!isRecord(output) || typeof output.base64 !== "string") {
        continue;
      }
      const base64 = output.base64;
      delete output.base64;
      output.omitted = true;
      output.bytes = estimateBase64DecodedBytes(base64);
    }
    for (const value of Object.values(node)) {
      pending.push(value);
    }
  }
}
