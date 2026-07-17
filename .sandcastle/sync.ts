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

  agent: codex("gpt-5.4-mini"),

  promptFile: "./.sandcastle/sync-prompt.md",

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
        },
      ],
    },
  },
});

printResult(output);

// Block deploy only on a genuine failure: a hard stop gate ("failed") or no
// push. "partial" means the agent pushed successfully and only a non-blocking
// check lane failed (e.g. the npm shrinkwrap guard's @smithy dual-major case
// that self-resolves) — that code is on origin/main and should still deploy.
if (output.status === "failed" || !output.pushed) {
  process.exit(1);
}
