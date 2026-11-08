import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WorkboardNodeWorktree } from "@openclaw/workboard-contract";
import { fetchNodeFile } from "./node-files.js";
import {
  hostGit,
  requireHostGit,
  runNodeCommand,
  type WorkboardNodeTicketRuntime,
} from "./node-ticket.js";

// file.fetch caps one file at 16 MiB. A larger bundle is cut on the node into
// parts the host fetches one by one: spec tickets that commit prototype
// screenshots each grilling round outgrow one fetch (SPEC-1 Lindra: 16.9 MB).
const FILE_FETCH_MAX_BYTES = 16 * 1024 * 1024;
// file.fetch's default limit: a part's base64 stays well inside the 25 MiB
// WebSocket frame even where a reply carries the payload twice.
const PART_MIB = 8;
const PART_BYTES = PART_MIB * 1024 * 1024;
// Bounds host memory; a branch this large has no business in a ticket.
const BUNDLE_MAX_PARTS = 32;

/**
 * Part names end in `.bundle` because node read policies grant
 * `<worktreesRoot>/*.bundle` (docs/plugins/workboard-node-setup.md).
 */
function bundlePartPath(bundlePath: string, index: number): string {
  return bundlePath.replace(/\.bundle$/u, `.part-${String(index + 1).padStart(3, "0")}.bundle`);
}

async function fetchNodeBundle(
  runtime: WorkboardNodeTicketRuntime,
  nodeId: string,
  bundlePath: string,
): Promise<Buffer> {
  const counted = await runNodeCommand(runtime, nodeId, ["wc", "-c", bundlePath]);
  const size = Number.parseInt(counted.trim().split(/\s+/u)[0] ?? "", 10);
  if (!Number.isSafeInteger(size)) {
    throw new Error(`node ${nodeId} reported no size for ${bundlePath}: ${counted}`);
  }
  if (size <= FILE_FETCH_MAX_BYTES) {
    return await fetchNodeFile(runtime, nodeId, bundlePath, FILE_FETCH_MAX_BYTES);
  }
  const count = Math.ceil(size / PART_BYTES);
  if (count > BUNDLE_MAX_PARTS) {
    throw new Error(
      `${bundlePath} is ${size} bytes; bundles over ${BUNDLE_MAX_PARTS * PART_MIB} MiB are not imported`,
    );
  }
  const parts = Array.from({ length: count }, (_, index) => bundlePartPath(bundlePath, index));
  try {
    const chunks: Buffer[] = [];
    for (const [index, part] of parts.entries()) {
      await runNodeCommand(runtime, nodeId, [
        "dd",
        `if=${bundlePath}`,
        `of=${part}`,
        "bs=1048576",
        `skip=${index * PART_MIB}`,
        `count=${PART_MIB}`,
      ]);
      chunks.push(await fetchNodeFile(runtime, nodeId, part, FILE_FETCH_MAX_BYTES));
    }
    return Buffer.concat(chunks);
  } finally {
    await runNodeCommand(runtime, nodeId, ["rm", "-f", ...parts]).catch(() => undefined);
  }
}

/**
 * Bundles the ticket branch's commits since its base on the node and hands
 * `use` a verified local copy of the bundle, with the base commit present in
 * the host clone. The caller decides which refs the bundle may write.
 */
export async function withNodeBundle<T>(
  runtime: WorkboardNodeTicketRuntime,
  params: {
    nodeId: string;
    worktree: Pick<WorkboardNodeWorktree, "path" | "branch" | "baseCommit">;
    bundlePath: string;
    hostRepoPath: string;
  },
  use: (localBundle: string) => Promise<T>,
): Promise<T> {
  const { nodeId, worktree, bundlePath, hostRepoPath } = params;
  await runNodeCommand(runtime, nodeId, [
    "git",
    "-C",
    worktree.path,
    "bundle",
    "create",
    bundlePath,
    `${worktree.baseCommit}..${worktree.branch}`,
  ]);
  const bundle = await fetchNodeBundle(runtime, nodeId, bundlePath);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "workboard-bundle-"));
  try {
    const localBundle = path.join(tempDir, path.posix.basename(bundlePath));
    await fs.writeFile(localBundle, bundle);
    // The node based the ticket on a freshly fetched origin; the host clone may lag behind it.
    const hasBase = await hostGit(hostRepoPath, [
      "cat-file",
      "-e",
      `${worktree.baseCommit}^{commit}`,
    ]);
    if (hasBase.code !== 0) {
      await requireHostGit(hostRepoPath, ["fetch", "--quiet", "origin"]);
    }
    await requireHostGit(hostRepoPath, ["bundle", "verify", "--quiet", localBundle]);
    return await use(localBundle);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}
