import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run, codex, Output } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { z } from "zod";

// Runs upstream sync steps 1–7 (fetch → rebase → install → build → check →
// fork-feature verification → push).  Step 8 (deploy) requires sudo/systemd —
// that runs on the host via scripts/sync-and-deploy.sh after this completes.
//
// Usage (standalone):    npx tsx .sandcastle/sync.ts
// Usage (full pipeline): bash scripts/sync-and-deploy.sh

const syncResultSchema = z.object({
  status: z.enum(["success", "partial", "failed"]),
  upstreamCommits: z.number(),
  // Release branch version this sync rebased onto (e.g. "2026.6.5"). The fork
  // tracks the newest upstream release branch, not main, so the deployed version
  // advances. Absent only on an early stop-gate failure before a target was picked.
  trackedRelease: z.string().optional(),
  conflicts: z.number(),
  build: z.enum(["passed", "failed", "skipped"]),
  tests: z.enum(["passed", "failed", "skipped"]),
  forkFeatures: z.enum(["verified", "failed", "skipped"]),
  // Subjects of fork-authored commits the agent deliberately dropped because
  // upstream superseded them. Any other fork commit missing after the rebase is
  // reported by the host as lost.
  droppedForkCommits: z.array(z.string()).optional(),
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
  for (const subject of result.droppedForkCommits ?? []) {
    console.log(`  Dropped fork commit     : ${subject}`);
  }
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

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repoDir, encoding: "utf8" }).trim();
}

// ── Preflight: reconcile this checkout with origin/main ─────────────────────
//
// Step 7 ends in `git push origin main --force-with-lease`, so whatever is not
// in the local `main` at that moment is erased from the fork. The lease is no
// protection here: it only compares against the remote-tracking ref, which any
// `git fetch` refreshes — so a checkout that merely sits *behind* origin passes
// the lease and silently drops the missing commits.
//
// That is the normal state of this fork between syncs: fixes land on
// origin/main as merged GitHub PRs and never touch this checkout. Four such PRs
// were already pending on origin when the 2026-09-14 run failed.
//
// Fast-forward when local `main` is strictly behind. Refuse when the two have
// diverged — picking which side survives is a maintainer's call, not this
// script's.
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
      `sync preflight: HEAD is on "${branch}", not main. The sync rebases and ` +
        (mainWorktree
          ? `publishes main; run it from ${mainWorktree}/scripts/sync-and-deploy.sh.`
          : `publishes main; check it out first.`),
    );
  }
  if (
    existsSync(join(repoDir, ".git/rebase-merge")) ||
    existsSync(join(repoDir, ".git/rebase-apply"))
  ) {
    throw new Error(
      "sync preflight: a rebase is already in progress in this checkout. " +
        "Finish or `git rebase --abort` it before syncing.",
    );
  }
  // Only tracked-file changes matter; untracked files are local-only additions.
  const dirty = git("status", "--porcelain", "--untracked-files=no");
  if (dirty) {
    throw new Error(
      `sync preflight: tracked files have uncommitted changes:\n${dirty}\n` +
        "Commit or restore them before syncing — the rebase would carry them along.",
    );
  }

  git("fetch", "origin", "main", "--prune");
  const behind = Number(git("rev-list", "--count", "main..origin/main"));
  const ahead = Number(git("rev-list", "--count", "origin/main..main"));

  if (behind === 0) {
    console.log(`[sync] checkout is level with origin/main (${ahead} unpushed commit(s))`);
    return git("rev-parse", "origin/main");
  }
  if (ahead > 0) {
    throw new Error(
      `sync preflight: main has diverged from origin/main (${ahead} local, ${behind} remote ` +
        `commit(s)). Rebasing and force-pushing from here would drop the ${behind} remote ` +
        `commit(s). Reconcile by hand, then re-run.`,
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

const preSyncOrigin = reconcileWithOrigin();
const pinnedRelease = resolvePinnedRelease();
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
  // Empty selects the newest release branch; see resolvePinnedRelease.
  promptArgs: { TARGET_RELEASE: pinnedRelease },

  // Must stay 1: sandcastle rejects `output` (the structured sync-result schema
  // below) on multi-iteration runs — "output requires maxIterations to be 1".
  // Raising it fails the run before the agent starts. A "Reached max iterations
  // (1)" line in the log is normal completion, not a truncated rebase; when a
  // sync stops early the cause is a stop-gate in sync-prompt.md, not this value.
  maxIterations: 1,

  // "head" = agent writes directly to the host working directory (no temp branch).
  // Required for upstream sync: rebase modifies main, force-push goes to origin.
  branchStrategy: { type: "head" },

  output: Output.object({ tag: "sync-result", schema: syncResultSchema }),

  hooks: {
    sandbox: {
      // Pre-install before the agent starts so its first build attempt doesn't
      // trigger a redundant install.  --no-frozen-lockfile because the rebase
      // may have changed pnpm-lock.yaml.  Retry with linear backoff so a
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
  throw error;
});

// Fork commits are the only ones a rebase must carry; upstream commits are
// replaced by the new release cut. Every commit the fork authored before the
// sync must still be on main by subject (SHAs are all rewritten), be present
// upstream by subject, or be declared dropped. The 2026.9.x rebases lost fork
// fixes silently, e.g. Control UI previews of /workspace/shared (OneDrive) links.
function forkSubjects(ref: string): string[] {
  const author = git("config", "user.name");
  return git("log", "--format=%an%x09%s", ref, "--not", "--remotes=upstream")
    .split("\n")
    .map((line) => line.split("\t"))
    .filter(([name, subject]) => name === author && subject)
    .map(([, subject]) => subject!);
}

function reportLostForkCommits(release: string | undefined, declared: string[]) {
  const kept = new Set(forkSubjects("main"));
  const upstream = new Set(
    release ? git("log", "--format=%s", `upstream/release/${release}`).split("\n") : [],
  );
  const lost = [...new Set(forkSubjects(preSyncOrigin))].filter(
    (subject) => !kept.has(subject) && !upstream.has(subject) && !declared.includes(subject),
  );
  if (lost.length === 0) {
    console.log("[sync] every pre-sync fork commit is on main, upstream, or declared dropped");
    return;
  }
  console.error(
    `\n✗ ${lost.length} fork commit(s) missing after the rebase and not declared dropped:\n` +
      lost.map((subject) => `    - ${subject}`).join("\n") +
      "\n  Restore them or confirm upstream superseded them before publishing.",
  );
}

printResult(output);

// Block deploy on a hard stop gate. "partial" means the agent pushed and only a
// non-blocking check lane failed (e.g. the npm shrinkwrap guard's @smithy
// dual-major case that self-resolves) — that code is on origin/main and should
// still deploy.
if (output.status === "failed") {
  process.exit(1);
}

// `pushed` is the agent's own report, and it says false for two different
// things: it refused to push, and it had nothing to push. A no-op sync cannot
// confirm a push at all — the sandbox holds no GitHub credentials — so taking
// it at face value skips the deploy on a perfectly good run. The host is the
// authority on whether main is published, so ask git instead.
if (!output.pushed) {
  git("fetch", "origin", "main", "--prune");
  const ahead = Number(git("rev-list", "--count", "origin/main..main"));
  const behind = Number(git("rev-list", "--count", "main..origin/main"));
  if (ahead !== 0 || behind !== 0) {
    reportLostForkCommits(output.trackedRelease, output.droppedForkCommits ?? []);
    console.error(
      `\n✗ Sync did not push and main is not level with origin/main ` +
        `(${ahead} local, ${behind} remote commit(s)) — skipping deploy.\n` +
        `  Publish by hand: git push origin main --force-with-lease=main:${preSyncOrigin}\n` +
        `  then: scripts/sync-and-deploy.sh --deploy-only`,
    );
    process.exit(1);
  }
  console.log("[sync] agent reported no push; main is level with origin/main — deploying that.");
}
