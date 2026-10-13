import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run, codex, Output } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { z } from "zod";

// Runs upstream sync steps 1–7: the host fetches, picks the target release, and
// starts the merge with its mechanical resolutions (scripts/sync-merge-release.mjs);
// the agent resolves what needs judgment, then installs, builds, checks, and
// verifies fork features; the host publishes the merge as a fast-forward of
// main. Step 8 (deploy) requires sudo/systemd — that runs on the host via
// scripts/sync-and-deploy.sh after this completes.
//
// Usage (standalone):    npx tsx .sandcastle/sync.ts
// Usage (full pipeline): bash scripts/sync-and-deploy.sh

const syncResultSchema = z.object({
  status: z.enum(["success", "partial", "failed"]),
  upstreamCommits: z.number(),
  // Release branch version this sync merged (e.g. "2026.6.5"). The fork
  // tracks the newest upstream release branch, not main, so the deployed version
  // advances. Absent only on an early stop-gate failure before a target was picked.
  trackedRelease: z.string().optional(),
  conflicts: z.number(),
  build: z.enum(["passed", "failed", "skipped"]),
  tests: z.enum(["passed", "failed", "skipped"]),
  forkFeatures: z.enum(["verified", "failed", "skipped"]),
  pushed: z.boolean(),
  deployNeeded: z.boolean(),
  newUpstreamCommits: z.number().optional(),
  failedCheckLanes: z.array(z.string()).optional(),
  notes: z.string().optional(),
});

type SyncResult = z.infer<typeof syncResultSchema>;

function printResult(result: SyncResult) {
  const icon = result.status === "success" ? "✓" : result.status === "partial" ? "⚠" : "✗";
  console.log(`\n${icon} Sync ${result.status.toUpperCase()}`);
  console.log(`  Tracked release branch  : ${result.trackedRelease ?? "(none)"}`);
  console.log(`  Release commits merged  : ${result.upstreamCommits}`);
  console.log(`  Conflicts resolved      : ${result.conflicts}`);
  console.log(`  Build                   : ${result.build}`);
  console.log(`  Tests                   : ${result.tests}`);
  console.log(`  Fork features           : ${result.forkFeatures}`);
  console.log(`  Pushed to origin/main   : ${result.pushed}`);
  if (result.failedCheckLanes?.length) {
    console.log(`  Failed check lanes      : ${result.failedCheckLanes.join(", ")}`);
  }
  if ((result.newUpstreamCommits ?? 0) > 0) {
    console.log(
      `  New upstream commits    : ${result.newUpstreamCommits} (arrived during run — sync again)`,
    );
  }
  if (result.notes) {
    console.log(`  Notes                   : ${result.notes}`);
  }
  if (result.deployNeeded) {
    console.log(`\n  Next: run deploy step (docs/UPSTREAM-SYNC.md step 8) manually.`);
  }
}

// Resolve the codex auth dir explicitly from HOME rather than relying on the
// sandbox to expand "~". This must point at the repo owner's auth (where
// `codex login` wrote auth.json). When the cron job runs as root it drops to
// the repo owner first (see scripts/sync-and-deploy.sh) so HOME is correct;
// CODEX_HOME can override if the auth lives elsewhere.
const codexHome = process.env.CODEX_HOME ?? `${process.env.HOME ?? "/home/frogger"}/.codex`;

// Corepack downloads the pinned pnpm binary from npm the first time it runs in a
// fresh sandbox. The host already has it cached under ~/.cache/node/corepack;
// mounting that dir lets the pinned pnpm resolve offline (see sandbox mounts).
const cacheHome = process.env.XDG_CACHE_HOME ?? `${process.env.HOME ?? "/home/frogger"}/.cache`;
const corepackCache = `${cacheHome}/node/corepack`;

// The agent bind-mounts and rewrites this checkout (branchStrategy "head"), so
// resolve the repo from this file rather than from cwd — standalone runs need
// the same root the cron pipeline uses.
const repoDir = join(dirname(fileURLToPath(import.meta.url)), "..");

// The lost-commit report lists every subject on a release branch (~5.7 MB on
// 2026.9.9 and growing); execFileSync's 1 MB default aborts it with ENOBUFS.
function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoDir,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  }).trim();
}

// ── Preflight: reconcile this checkout with origin/main ─────────────────────
//
// The sync merges into the local `main` and publishes it as a fast-forward of
// origin/main, so it must start from origin/main exactly. Fixes land on
// origin/main as merged GitHub PRs and never touch this checkout, so a checkout
// that sits behind is the normal state between syncs: fast-forward it. Refuse
// when the two have diverged — picking which side survives is a maintainer's
// call, not this script's.
function reconcileWithOrigin(): string {
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch !== "main") {
    // main can be checked out in only one worktree, so name it: a feature
    // worktree's copy of this script is usually stale anyway.
    const mainWorktree = git("worktree", "list", "--porcelain")
      .split("\n\n")
      .find((block) => block.includes("\nbranch refs/heads/main"))
      ?.match(/^worktree (.+)$/m)?.[1];
    throw new Error(
      `sync preflight: HEAD is on "${branch}", not main. The sync merges into and ` +
        (mainWorktree
          ? `publishes main; run it from ${mainWorktree}/scripts/sync-and-deploy.sh.`
          : `publishes main; check it out first.`),
    );
  }
  const gitDir = git("rev-parse", "--git-dir");
  if (existsSync(join(repoDir, gitDir, "MERGE_HEAD"))) {
    throw new Error(
      "sync preflight: a merge is already in progress in this checkout. " +
        "`git merge --abort` it before syncing.",
    );
  }
  if (
    existsSync(join(repoDir, gitDir, "rebase-merge")) ||
    existsSync(join(repoDir, gitDir, "rebase-apply"))
  ) {
    throw new Error(
      "sync preflight: a rebase is already in progress in this checkout. " +
        "`git rebase --abort` it before syncing.",
    );
  }
  // Only tracked-file changes matter; untracked files are local-only additions.
  const dirty = git("status", "--porcelain", "--untracked-files=no");
  if (dirty) {
    throw new Error(
      `sync preflight: tracked files have uncommitted changes:\n${dirty}\n` +
        "Commit or restore them before syncing — the merge would carry them along.",
    );
  }

  git("fetch", "origin", "main", "--prune");
  const behind = Number(git("rev-list", "--count", "main..origin/main"));
  const ahead = Number(git("rev-list", "--count", "origin/main..main"));

  if (behind === 0 && ahead === 0) {
    console.log("[sync] checkout is level with origin/main");
    return git("rev-parse", "origin/main");
  }
  if (ahead > 0) {
    throw new Error(
      `sync preflight: main has commits origin/main lacks (${ahead} local, ${behind} remote ` +
        `commit(s)). The sync publishes main as a fast-forward of origin/main. Reconcile by ` +
        `hand, then re-run.`,
    );
  }
  console.log(`[sync] fast-forwarding main to origin/main (${behind} commit(s) behind)`);
  git("merge", "--ff-only", "origin/main");
  console.log(`[sync] now at ${git("rev-parse", "--short", "HEAD")}`);
  return git("rev-parse", "origin/main");
}

// Codex reports a rejected request — a retired model pin, expired ChatGPT auth —
// as a `task_complete` event on its `--json` stdout stream. Sandcastle's
// AgentError carries only stderr, which at that point holds nothing but
// "Reading prompt from stdin...", so the real reason is discarded: the
// 2026-09-14 run alerted "exit 1" while the actual message ("The 'gpt-5.4-mini'
// model is not supported when using Codex with a ChatGPT account") sat unread in
// the rollout transcript. Recover it — an unattended failure has to name its own
// cause. Best-effort: never let this mask the original error.
function describeCodexFailure(since: number): string | undefined {
  try {
    const sessionsDir = join(codexHome, "sessions");
    if (!existsSync(sessionsDir)) {
      return undefined;
    }

    const rollouts: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
          if (statSync(full).mtimeMs >= since) {
            rollouts.push(full);
          }
        }
      }
    };
    walk(sessionsDir);
    if (rollouts.length === 0) {
      return undefined;
    }
    rollouts.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);

    for (const rollout of rollouts) {
      const lines = readFileSync(rollout, "utf8").split("\n").filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        let payload: { type?: string; error?: { message?: string } } | undefined;
        try {
          payload = JSON.parse(lines[i]!)?.payload;
        } catch {
          continue;
        }
        const message = payload?.type === "task_complete" ? payload.error?.message : undefined;
        if (!message) {
          continue;
        }
        // Codex nests the upstream API error as a JSON string; unwrap it.
        try {
          const inner = JSON.parse(message)?.error?.message;
          if (typeof inner === "string") {
            return inner;
          }
        } catch {
          // Not nested JSON — the message is already plain text.
        }
        return message;
      }
    }
  } catch {
    // Transcript layout changed or is unreadable — fall back to the raw error.
  }
  return undefined;
}

// ── Optional release pin ────────────────────────────────────────────────────
//
// By default the agent rebases onto the newest upstream `release/X.Y.Z` branch.
// That is wrong when the newest cut is a fresh beta far ahead of the deployed
// line (2026.10.1 landed 2005 commits over 2026.9.7, beyond what one agent
// iteration can rebase) while a small patch cut (2026.9.8) is the one to ship.
// SYNC_TARGET_RELEASE=X.Y.Z pins the target. Validate it here, before the
// sandbox starts: a typo or a downgrade below the version main already carries
// would otherwise only surface mid-rebase, or replant the fork onto an older
// independent cut.
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) {
      return pa[i] - pb[i];
    }
  }
  return 0;
}

function resolvePinnedRelease(): string {
  const pinned = process.env.SYNC_TARGET_RELEASE?.trim() ?? "";
  if (!pinned) {
    return "";
  }
  if (!/^\d+\.\d+\.\d+$/.test(pinned)) {
    throw new Error(
      `sync preflight: SYNC_TARGET_RELEASE="${pinned}" is not a release version (X.Y.Z).`,
    );
  }
  try {
    git(
      "fetch",
      "upstream",
      `+refs/heads/release/${pinned}:refs/remotes/upstream/release/${pinned}`,
    );
  } catch {
    throw new Error(`sync preflight: upstream has no release/${pinned} branch.`);
  }
  const current = JSON.parse(git("show", "HEAD:package.json")).version as string;
  if (compareVersions(pinned, current) < 0) {
    throw new Error(
      `sync preflight: SYNC_TARGET_RELEASE=${pinned} is older than main's ${current}. ` +
        "Release branches are independent cuts; rebasing onto an older one is a downgrade.",
    );
  }
  console.log(`[sync] pinned target release: upstream/release/${pinned} (main is ${current})`);
  return pinned;
}

// The newest upstream `release/X.Y.Z` by version, unless the host pinned one.
// `release-ci/*` (hash-named CI snapshots) and suffixed names never qualify.
function resolveTarget(pinned: string): string {
  if (pinned) {
    return pinned;
  }
  const versions = git(
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/remotes/upstream/release/",
  )
    .split("\n")
    .map((ref) => ref.replace(/^upstream\/release\//, ""))
    .filter((name) => /^\d+\.\d+\.\d+$/.test(name))
    .toSorted(compareVersions);
  const newest = versions.at(-1);
  if (!newest) {
    throw new Error("sync preflight: upstream has no release/X.Y.Z branch.");
  }
  return newest;
}

type MergeStart =
  | { state: "up-to-date"; target: string; upstreamCommits: 0 }
  | {
      state: "merging";
      target: string;
      upstreamCommits: number;
      conflicted: number;
      mechanical: Record<string, string[]>;
      remaining: string[];
    };

const preSyncOrigin = reconcileWithOrigin();
git("fetch", "upstream", "--prune");
const pinnedRelease = resolvePinnedRelease();
const target = resolveTarget(pinnedRelease);
// Files the sync creates must be committed; these were already here.
const untrackedBefore = new Set(untrackedFiles());
let mergeStart: MergeStart;
try {
  mergeStart = JSON.parse(
    execFileSync("node", ["scripts/sync-merge-release.mjs", target], {
      cwd: repoDir,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    }),
  ) as MergeStart;
} catch (error) {
  console.error(`\n✗ Starting the merge of upstream/release/${target} failed: ${String(error)}`);
  parkFailedAttempt();
  process.exit(1);
}

if (mergeStart.state === "up-to-date") {
  printResult({
    status: "success",
    upstreamCommits: 0,
    trackedRelease: target,
    conflicts: 0,
    build: "skipped",
    tests: "skipped",
    forkFeatures: "skipped",
    pushed: true,
    deployNeeded: true,
    notes: `main already contains upstream/release/${target}; nothing to merge.`,
  });
  process.exit(0);
}
for (const [rule, files] of Object.entries(mergeStart.mechanical)) {
  console.log(`[sync] mechanical (${rule}): ${files.length} file(s)`);
}
console.log(
  `[sync] merging upstream/release/${target}: ${mergeStart.upstreamCommits} commit(s), ` +
    `${mergeStart.conflicted} conflicted file(s), ${mergeStart.remaining.length} left for the agent`,
);
const runStartedAt = Date.now();

const { output } = await run({
  name: "upstream-sync",

  sandbox: docker({
    mounts: [
      // codexHome must be writable — codex writes session logs/state and the
      // refreshed OAuth token to <codexHome>/{log,tmp,auth.json} at runtime.
      { hostPath: codexHome, sandboxPath: "~/.codex" },
      // Reuse the host corepack cache so the pinned pnpm binary needs no
      // network. A fresh sandbox cache re-fetched it from npm every run, and a
      // single 10s connect-timeout blip there aborted the whole sync. Writable
      // so a later packageManager pin bump can still populate it.
      { hostPath: corepackCache, sandboxPath: "~/.cache/node/corepack" },
    ],
  }),

  // Pinned explicitly so a sync is reproducible. Codex rejects a retired model
  // outright ("not supported when using Codex with a ChatGPT account") and the
  // run dies before the first turn — which is how gpt-5.4-mini stopped the
  // 2026-09-14 sync. When that happens, repin to a model codex still advertises.
  agent: codex("gpt-5.6-terra"),

  promptFile: "./.sandcastle/sync-prompt.md",
  promptArgs: {
    TARGET_RELEASE: target,
    UPSTREAM_COMMITS: String(mergeStart.upstreamCommits),
    CONFLICTED: String(mergeStart.conflicted),
    REMAINING_CONFLICTS: mergeStart.remaining.map((file) => `- ${file}`).join("\n") || "(none)",
  },

  // Must stay 1: sandcastle rejects `output` (the structured sync-result schema
  // below) on multi-iteration runs — "output requires maxIterations to be 1".
  // Raising it fails the run before the agent starts. A "Reached max iterations
  // (1)" line in the log is normal completion, not a truncated merge; when a
  // sync stops early the cause is a stop-gate in sync-prompt.md, not this value.
  maxIterations: 1,

  // "head" = agent writes directly to the host working directory (no temp branch):
  // it finishes the merge the host started on main.
  branchStrategy: { type: "head" },

  output: Output.object({ tag: "sync-result", schema: syncResultSchema }),

  hooks: {
    sandbox: {
      // Pre-install before the agent starts so its first build attempt doesn't
      // trigger a redundant install.  --no-frozen-lockfile because the merge
      // takes the release's pnpm-lock.yaml and the fork's own dependencies
      // re-resolve on top.  Retry with linear backoff so a
      // transient npm registry blip (corepack binary fetch or dependency
      // downloads) does not abort the whole sync. Runs under `sh -c` in the
      // container, so this is a POSIX-sh loop, not a JS expression.
      onSandboxReady: [
        {
          command:
            "for attempt in 1 2 3; do " +
            "CI=true corepack pnpm install --no-frozen-lockfile && exit 0; " +
            'echo "[sync] pnpm install attempt $attempt failed; retrying in $((attempt * 15))s" >&2; ' +
            "sleep $((attempt * 15)); " +
            "done; " +
            'echo "[sync] pnpm install failed after 3 attempts" >&2; exit 1',
          // Sandcastle caps a hook at 60s by default, which is shorter than this
          // loop's own backoff (15s + 30s of sleep before the third attempt) —
          // so the retries above could never run, and the first slow install
          // killed the whole sync (the 2026-09-10 run). Budget the full three
          // attempts plus backoff.
          timeoutMs: 15 * 60 * 1000,
        },
      ],
    },
  },
}).catch((error: unknown) => {
  const reason = describeCodexFailure(runStartedAt);
  if (reason) {
    console.error(`\n✗ Sync agent failed: ${reason}`);
  }
  parkFailedAttempt();
  throw error;
});

// A failed sync must not strand the checkout: park the attempt for inspection
// and put main back on origin/main, so the next run starts clean.
function parkFailedAttempt() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 13);
  const branch = `sync/attempt-${target}-${stamp}`;
  const created = createdFiles();
  try {
    // Tracked and newly created files, conflicted ones included; never stash
    // (the stack is shared with every worktree).
    git("add", "-u");
    if (created.length > 0) {
      git("add", "--", ...created);
    }
    const attempt = git(
      "commit-tree",
      git("write-tree"),
      "-p",
      "HEAD",
      "-m",
      `sync attempt: upstream/release/${target}`,
    );
    git("branch", branch, attempt);
    console.error(`  The attempt is parked on branch ${branch}.`);
  } catch (error) {
    console.error(`  Could not park the attempt: ${String(error)}`);
  }
  // Get back to main whatever the agent left behind: a rebase, another
  // branch, a merge. Each step runs even when an earlier one failed.
  const recover = (...args: string[]) => {
    try {
      git(...args);
    } catch (error) {
      console.error(`  git ${args.join(" ")} failed: ${String(error)}`);
    }
  };
  const gitDir = git("rev-parse", "--git-dir");
  if (
    existsSync(join(repoDir, gitDir, "rebase-merge")) ||
    existsSync(join(repoDir, gitDir, "rebase-apply"))
  ) {
    recover("rebase", "--abort");
  }
  recover("checkout", "-f", "main");
  recover("reset", "--hard", preSyncOrigin);
  for (const file of created) {
    rmSync(join(repoDir, file), { force: true });
  }
  console.error("  main is back on origin/main.");
}

function untrackedFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z", "--others", "--exclude-standard"], {
    cwd: repoDir,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean);
}

function createdFiles(): string[] {
  return untrackedFiles().filter((file) => !untrackedBefore.has(file));
}

printResult(output);

// Block deploy on a hard stop gate. "partial" means only a non-blocking check
// lane failed (e.g. the npm shrinkwrap guard's @smithy dual-major case that
// self-resolves) — that merge is still published and deployed.
if (output.status === "failed") {
  parkFailedAttempt();
  process.exit(1);
}

// The host is the authority on what gets published: a finished merge of the
// target on top of everything origin/main had, committed and clean.
const problems = [
  existsSync(join(repoDir, git("rev-parse", "--git-dir"), "MERGE_HEAD")) &&
    "the merge is not committed",
  git("status", "--porcelain", "--untracked-files=no") && "tracked files have uncommitted changes",
  createdFiles().length > 0 &&
    `files created during the sync are not committed (${createdFiles().slice(0, 5).join(", ")})`,
  !isAncestor(`upstream/release/${target}`, "main") &&
    `main does not contain upstream/release/${target}`,
  !isAncestor(preSyncOrigin, "main") && "main lost commits origin/main had before the sync",
].filter(Boolean);
if (problems.length > 0) {
  console.error(`\n✗ Not publishing: ${problems.join("; ")}.`);
  parkFailedAttempt();
  process.exit(1);
}
// A plain push only fast-forwards; git rejects it if origin/main moved meanwhile.
try {
  git("push", "origin", "main");
} catch (error) {
  // Usually origin/main moved during the sync; the next run merges again from it.
  console.error(`\n✗ Publishing main failed: ${String(error)}`);
  parkFailedAttempt();
  process.exit(1);
}
console.log(`[sync] published main ${git("rev-parse", "--short", "main")} to origin`);

function isAncestor(ancestor: string, descendant: string): boolean {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd: repoDir });
    return true;
  } catch {
    return false;
  }
}
