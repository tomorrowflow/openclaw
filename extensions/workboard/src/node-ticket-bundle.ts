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

// file.fetch's hard cap; a larger bundle fails on the node with FILE_TOO_LARGE.
const BUNDLE_MAX_BYTES = 16 * 1024 * 1024;

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
  const bundle = await fetchNodeFile(runtime, nodeId, bundlePath, BUNDLE_MAX_BYTES);
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
