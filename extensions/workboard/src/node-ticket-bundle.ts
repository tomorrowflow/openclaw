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

// file.fetch caps one file at 16 MiB, so the node splits the bundle and the
// host fetches the parts. Spec tickets that commit prototype screenshots each
// grilling round outgrow one fetch (SPEC-1 Lindra: 16.9 MB).
const BUNDLE_PART_MAX_BYTES = 16 * 1024 * 1024;
const BUNDLE_PART_SIZE = "15m";
// Bounds host memory; a branch this large has no business in a ticket.
const BUNDLE_MAX_PARTS = 16;

function findParts(prefix: string, ...action: string[]): string[] {
  // -H: macOS worktree roots under /tmp are symlinks, which find would not enter.
  return [
    "find",
    "-H",
    path.posix.dirname(prefix),
    "-maxdepth",
    "1",
    "-name",
    `${path.posix.basename(prefix)}*`,
    ...action,
  ];
}

async function fetchBundleParts(
  runtime: WorkboardNodeTicketRuntime,
  nodeId: string,
  bundlePath: string,
): Promise<Buffer> {
  const prefix = `${bundlePath}.part.`;
  // Parts a failed cleanup left would join this bundle's parts.
  await runNodeCommand(runtime, nodeId, findParts(prefix, "-delete"));
  try {
    await runNodeCommand(runtime, nodeId, [
      "split",
      "-b",
      BUNDLE_PART_SIZE,
      "-a",
      "3",
      bundlePath,
      prefix,
    ]);
    const listed = await runNodeCommand(runtime, nodeId, findParts(prefix));
    const parts = listed.split("\n").filter(Boolean).toSorted();
    if (parts.length === 0 || parts.length > BUNDLE_MAX_PARTS) {
      throw new Error(
        `node ${nodeId} split ${bundlePath} into ${parts.length} parts; expected 1 to ${BUNDLE_MAX_PARTS}`,
      );
    }
    const chunks: Buffer[] = [];
    for (const part of parts) {
      chunks.push(await fetchNodeFile(runtime, nodeId, part, BUNDLE_PART_MAX_BYTES));
    }
    return Buffer.concat(chunks);
  } finally {
    // Best effort: the next import deletes leftovers before it splits.
    await runNodeCommand(runtime, nodeId, findParts(prefix, "-delete")).catch(() => undefined);
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
  const bundle = await fetchBundleParts(runtime, nodeId, bundlePath);
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
