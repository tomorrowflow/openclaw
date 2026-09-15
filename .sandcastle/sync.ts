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
function reconcileWithOrigin() {
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch !== "main") {
    throw new Error(
      `sync preflight: HEAD is on "${branch}", not main. The sync rebases and ` +
        `force-pushes main; check it out first.`,
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
    return;
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

reconcileWithOrigin();
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

printResult(output);

// Block deploy only on a genuine failure: a hard stop gate ("failed") or no
// push. "partial" means the agent pushed successfully and only a non-blocking
// check lane failed (e.g. the npm shrinkwrap guard's @smithy dual-major case
// that self-resolves) — that code is on origin/main and should still deploy.
if (output.status === "failed" || !output.pushed) {
  process.exit(1);
}
