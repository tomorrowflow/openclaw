import { createHash, randomUUID } from "node:crypto";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { nodeInvokePayload, type WorkboardNodeTicketRuntime } from "./node-ticket.js";

// File-transfer's node commands as Workboard calls them. The node's file-transfer
// policy (allowReadPaths) and gateway.nodes.commands.allow decide what they may read.

const DIR_LIST_TIMEOUT_MS = 20_000;

/** The `code message` a file-transfer node command reports with `ok: false`. */
function nodeErrorReason(payload: Record<string, unknown>): string {
  const reason = [payload.code, payload.message].filter((part) => typeof part === "string");
  return reason.join(" ") || "error";
}

/** A node file's bytes through `file.fetch`, checked against its sha256. */
export async function fetchNodeFile(
  runtime: WorkboardNodeTicketRuntime,
  nodeId: string,
  filePath: string,
  maxBytes: number,
): Promise<Buffer> {
  const payload = nodeInvokePayload(
    await runtime.request(
      "node.invoke",
      {
        nodeId,
        command: "file.fetch",
        params: { path: filePath, maxBytes },
        idempotencyKey: randomUUID(),
      },
      { scopes: ["operator.admin"] },
    ),
  );
  if (payload.ok === false) {
    throw new Error(`node ${nodeId} could not send ${filePath}: ${nodeErrorReason(payload)}`);
  }
  if (typeof payload.base64 !== "string" || typeof payload.sha256 !== "string") {
    throw new Error(`node ${nodeId} returned an invalid file.fetch payload for ${filePath}`);
  }
  const bytes = Buffer.from(payload.base64, "base64");
  if (createHash("sha256").update(bytes).digest("hex") !== payload.sha256.toLowerCase()) {
    throw new Error(`the fetched file ${filePath} does not match its sha256`);
  }
  return bytes;
}

type NodeDirEntry = { name: string; isDir: boolean; isFile: boolean; size: number; mtime: number };

/** One page of a node dir; a dir the agent has not created yet lists as empty. */
export async function listNodeDir(
  runtime: WorkboardNodeTicketRuntime,
  nodeId: string,
  dirPath: string,
  maxEntries: number,
): Promise<NodeDirEntry[]> {
  const payload = nodeInvokePayload(
    await runtime.request(
      "node.invoke",
      {
        nodeId,
        command: "dir.list",
        params: { path: dirPath, maxEntries },
        timeoutMs: DIR_LIST_TIMEOUT_MS,
        idempotencyKey: randomUUID(),
      },
      { scopes: ["operator.admin"] },
    ),
  );
  if (payload.ok === false) {
    if (payload.code === "NOT_FOUND") {
      return [];
    }
    throw new Error(`node ${nodeId} could not list ${dirPath}: ${nodeErrorReason(payload)}`);
  }
  if (!Array.isArray(payload.entries)) {
    throw new Error(`node ${nodeId} returned an invalid dir.list payload for ${dirPath}`);
  }
  return payload.entries.flatMap((entry): NodeDirEntry[] =>
    isRecord(entry) &&
    typeof entry.name === "string" &&
    isPathSegment(entry.name) &&
    typeof entry.size === "number" &&
    typeof entry.mtime === "number"
      ? [
          {
            name: entry.name,
            isDir: entry.isDir === true,
            isFile: entry.isFile === true,
            size: entry.size,
            mtime: entry.mtime,
          },
        ]
      : [],
  );
}

/** A single path segment: not empty, `.`, `..`, or containing a slash. */
export function isPathSegment(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && !name.includes("/");
}
