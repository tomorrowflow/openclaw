# Upstream Sync Task

You are running the upstream sync procedure defined in `docs/UPSTREAM-SYNC.md`.
Execute steps 1–6 (fetch through commit). The host publishes (step 7) and
deploys (step 8) — stop before both.

## Environment notes

- `pnpm` is **not** on PATH. Use `corepack pnpm` for every pnpm command.
- `pnpm install` was already run before you started (via `onSandboxReady`).
- Untracked files (`??` in `git status`) that were there before you started are
  local-only additions; ignore them. **Every file you create must be committed:**
  the host refuses to publish a `main` with files created during the sync left
  untracked, because `origin/main` would not build without them.

## Procedure

Follow `docs/UPSTREAM-SYNC.md` exactly. Key reminders per step:

### Step 2–4: Finish the merge the host started

This fork tracks the newest upstream **release** branch (or the one the host
pinned), not `main`, and syncs by **merging** it into `main`. The host already:

- fetched upstream and picked the target: `upstream/release/{{TARGET_RELEASE}}`,
  which brings in {{UPSTREAM_COMMITS}} commit(s);
- ran `git merge --no-ff --no-commit upstream/release/{{TARGET_RELEASE}}` on
  `main` ({{CONFLICTED}} file(s) conflicted);
- resolved the mechanical classes with `scripts/sync-merge-release.mjs`: upstream
  CI the fork does not keep, `package.json` version hunks, release-owned
  changelogs and generated files, `pnpm-lock.yaml`, files only an earlier release
  cut changed, and the root `version` pin plus the fork's `deploy:globally`
  script.

These files are still conflicted and are yours:

{{REMAINING_CONFLICTS}}

`TARGET={{TARGET_RELEASE}}` in the commands below. Never re-run the merge, never
`git merge --abort`, and never rebase: the host owns starting and abandoning the
merge. Do not take either side of a source file wholesale; each conflict below
needs both sides read.

In a merge, `--ours` is fork `main` and `--theirs` is the release. Inspect a file
with the common base shown: `git checkout --conflict=diff3 -- <file>`.

### Conflict resolution rules

Apply these per file, in order:

- **Generated files** — a plugin manifest's `controlUi` hashes
  (`extensions/*/openclaw.plugin.json`), `docs/.generated/*`: take the release's
  hunk. The build regenerates them.
- **Ratchet baselines** (`config/*-baseline.txt`): take the release's hunk, then
  run the matching check (`corepack pnpm check:assertion-safety` and friends) in
  Step 5c and correct only counts it reports wrong. A merge carries both sides'
  entries, so a ratchet compared against one parent alone reports the other
  side's entries as growth; that is not a regression.
- **Fork patch on code upstream refactored** (the common case): keep upstream's
  new structure and re-apply only the fork's change on top, using upstream's
  current names. Read the fork's intent first: `git log --format='%h %s'
$(git merge-base HEAD MERGE_HEAD)..HEAD -- <file>` lists the fork commits.
  Union import lists, then let Step 5c's lint drop what upstream made unused.
- **Fork patch whose upstream premise was deleted** (a modify/delete conflict, or
  a symbol gone from the release): accept upstream's version only when **all
  four** hold, and otherwise stop:
  1. The symbol or contract the patch depends on is gone from the release:
     `git grep -q '<symbol>' "upstream/release/$TARGET" -- src/` returns nothing.
  2. No entry in `docs/fork-features.txt` covers the behaviour.
  3. Upstream still covers the user-visible behaviour by another route, or the
     behaviour is meaningless without the deleted contract. Name the upstream
     file that carries it now.
  4. Upstream has regression coverage for that behaviour, or the fork's own test
     for it is unreproducible because its trigger no longer exists.
     Record each such drop in `notes` with the four findings. Precedent: the 10.5
     sync accepted the deletion of `src/skills/workshop/maintenance-prompt.ts`
     because upstream retired the collection review it fed (#161057).
- **Upstream changed a contract the fork calls** (a new required parameter, a
  changed outcome source): adapt the fork's callers and tests to the new
  contract, and keep the fork's ordering guarantees explicit. Precedent: the
  10.5 sync made Workboard's `agent_end` read the session owner's outcome before
  mapping a node ticket's report, so a failed attempt during model fallback does
  not block the card.

After the last file, `git add` the resolutions and commit the merge with the
host's message: `git commit --no-edit`. Everything after that is an ordinary
fixup commit on top (Step 6).

**Auto-merged code needs a typecheck, not trust.** A conflict-free merge of
fork code can still call a name upstream moved or removed (the 10.5 sync found
`normalizeLabels` and `toDisplayPath` this way). Run `corepack pnpm tsgo:core`,
`tsgo:extensions`, `tsgo:core:test`, and `tsgo:extensions:test` before you trust
any test result, and migrate fork callers to upstream's replacement rather than
restoring the old name. The `tsgo:core:test` error importing a `.github` fixture
(`test-prerequisites.json`) is the known gap from the fork deleting upstream CI.

Report `upstreamCommits: {{UPSTREAM_COMMITS}}`, `trackedRelease:
"{{TARGET_RELEASE}}"`, and `conflicts: {{CONFLICTED}}`.

### Step 5a: Install

Already done by `onSandboxReady`, on the release's `pnpm-lock.yaml` the host took. If you
change a `package.json` or the lockfile while resolving, re-run:

```bash
CI=true corepack pnpm install --no-frozen-lockfile
```

**If install stops making progress, kill it and rerun once.** A re-resolving
install can wedge on the pnpm store index: the process stays alive but idle, so
it looks like a slow install rather than a hang. Distinguish them by CPU, not by
elapsed time — `ps -o pid,stat,etime,%cpu,cmd -p <pid>` plus a second sample.
Steady 0% CPU with no new writes under `node_modules/` is wedged; kill it and run
the same command again, which normally converges in seconds because resolution is
already cached. Do not sit through repeated quiet intervals waiting for it, and do
not report the sync as blocked on a build that never started: the lockfile work
usually completed before the stall.

### Step 5b: Build

```bash
OPENCLAW_INCLUDE_OPTIONAL_BUNDLED=1 corepack pnpm build
```

If new packages appear in the `[ERR_PNPM_IGNORED_BUILDS]` warning, add them to
`pnpm-workspace.yaml` under `allowBuilds:` — always use `true` or `false`, never
placeholder text. Image/audio/native packages (sharp, canvas, pty, llama, etc.) → `true`.
Known-problematic packages (koffi, @discordjs/opus, tree-sitter-bash) → `false`.

### Step 5c: Check

`pnpm check` spawns nested `pnpm` calls that fail with ENOENT because pnpm is not
on PATH. Create a shim first:

```bash
mkdir -p .tmp/bin
printf '#!/bin/sh\nexec corepack pnpm "$@"\n' > .tmp/bin/pnpm
chmod +x .tmp/bin/pnpm
PATH="$(pwd)/.tmp/bin:$PATH" CI=true corepack pnpm check
```

Remove `.tmp/` before any commit:

```bash
rm -rf .tmp/
```

### Shrinkwrap check failures

If `pnpm check` fails **only** on the `npm shrinkwrap guard` lane:

1. Run `PATH="$(pwd)/.tmp/bin:$PATH" corepack pnpm deps:shrinkwrap:generate`
2. If the generator reports "package versions absent from pnpm-lock.yaml", check
   the age of those packages: `npm view <package> time --json`
3. If the package was published **less than 48 hours ago**:
   - Add it to `pnpm-workspace.yaml` `minimumReleaseAgeExclude`
   - **AND** add a version pin to `pnpm-workspace.yaml` `overrides` using the version
     currently in `pnpm-lock.yaml` (prevents the generator from resolving a newer version)
   - **Do NOT** bump direct dependency versions in extension `package.json` files
4. After adding the override, run `CI=true corepack pnpm install --no-frozen-lockfile`
   and regenerate again.
5. If the package has **two major version lines** in `pnpm-lock.yaml` (e.g. `2.x` and
   `4.x`), **do not add a workspace override** — it would force the wrong major on v2
   consumers. Accept the single failing lane and note it. This self-resolves on the next
   sync once pnpm picks up the new version naturally.

If only `npm shrinkwrap guard` fails and you've followed the above, set
`status: "partial"` with `failedCheckLanes: ["npm shrinkwrap guard"]` and continue
— it is not a blocker.

### Step 5d: Tests (conflict-scoped)

Run tests only for files that had actual conflict resolutions. Skip if no source
files conflicted (pnpm-lock.yaml and workflow deletes don't count).

```bash
OPENCLAW_VITEST_MAX_WORKERS=4 corepack pnpm vitest run \
  <test-file-for-each-conflicted-source-file>
```

**Always pass explicit `.test.ts` paths, never a bare directory or path prefix.**
A directory-shaped filter can select files into the wrong Vitest lane, where that
lane's setup and mocks do not apply and tests fall through to real network calls.
The result is a large, noisy, run-to-run-varying failure count that has nothing to
do with the merge. If a suite fails, rerun the exact failing files by full path
before believing the failure — if they pass that way, it was lane misrouting.
Failures whose reported paths begin with `../../` are the tell.

### Step 5f: Fork features

```bash
node scripts/check-fork-features.mjs
```

It exits 0 on `fork features: N present`, or names every missing entry with its
file, its pattern, and why the feature matters, and exits 1. The same check runs
again in `scripts/sync-and-deploy.sh` before the deploy builds, so anything you
leave missing here fails the deploy rather than shipping.

#### Triage every MISSING before treating it as a stop gate

A MISSING line means "this grep no longer matches" — **not** automatically "the
fork feature was lost". Upstream refactors move and rename things, and upstream
sometimes absorbs a fork feature outright. Classify each MISSING by reading the
code before you decide, because the two outcomes need opposite actions:

1. **Genuinely lost** — the behaviour is gone. Confirm by searching the whole
   repo for the symbol _and_ for whatever replaced it (`rg -n '<symbol>' src/`),
   and by checking the feature is still reachable. A symbol that still exists but
   which nothing imports is also "lost" — it is dead code, and the feature is off.
   → Re-apply the patch, keep the entry, continue.
2. **Moved / renamed / split** — the behaviour is intact under a new symbol or in
   a new file (upstream splitting `ops.ts` into `ops-*.ts`, or extracting a schema
   into its own module). Verify by reading the new site.
   → **Update `docs/fork-features.txt`** to point at the new symbol/file. Do not
   re-add the old code; that would duplicate upstream.
3. **Upstreamed** — upstream now implements the feature itself. Verify with
   `git show upstream/release/$TARGET:<file> | grep <symbol>`.
   → Update the entry to the upstream location and note `(upstreamed $TARGET)` in
   the description. Do not re-apply the fork patch on top of upstream's version.

Only case 1 that you could not repair is a stop gate. Cases 2 and 3 are checklist
maintenance: fix the file, commit it in Step 6, and continue the sync.

Some entries point at an **upstream test** whose expectation the fork supersedes.
A resolution that takes upstream's copy of that file wholesale reverts the fork's
expectation, and the suite goes red against fork behaviour that is working as intended.
Those are case 1: re-apply the fork's expectation, keep the comment that explains
the divergence, and do not "fix" the production code to satisfy upstream's copy.

#### Every fork fix needs a checklist entry

A fork fix committed between syncs is only protected once
`docs/fork-features.txt` asserts it. Fixes without an entry are exactly the ones
earlier rebase-based syncs dropped silently, and nobody noticed until a user did. The
Control UI's container-path previews of `/workspace/shared/...` (OneDrive and
Syncthing) links broke that way after a sync and had to be re-landed. Before
Step 6, list the fork-authored commits since the last sync and check that each
non-sync fix has an entry:

```bash
# origin/main is still the pre-sync tree: only the host publishes.
git log --format='%h %an %s' origin/main --not --remotes=upstream \
  --author="$(git config user.name)" \
  | grep -vE ' (chore/fix|fix\(sync\)|docs\(fork-features\)|fix\(sandcastle\)|fix\(deploy\)):'
```

For each one with no entry, add one that asserts the **call or condition** that
carries the behavior, not an import or a type field, since those survive a
resolution that drops the behavior. Commit it with the Step 6 fixups.

If you leave a stale entry unfixed, it fails again on _every_ future sync and
trains the next run to "restore" code upstream already has. Treat a checklist that
has been failing across multiple syncs as a bug in the checklist, not the code.

**Never encode a dependency version literal as a fork feature.** Version pins must
track upstream (see Step 5g); a literal like `fs-safe.*0\.4\.4` turns a correct
upstream bump into a permanent false failure and invites a downgrade that breaks
the build.

#### Never fix a build break with a compatibility shim

When the build fails on a missing export or module after the merge, the cause is
almost always that a conflict was resolved by keeping the fork's whole copy of a
file, which reverted an upstream rename or module split. Upstream callers then
reference names the fork's copy no longer has.

Do **not** create an alias export, a re-export file at the old path, or any
other shim to satisfy the build. That leaves two spellings of one concept, hides
the stale file, and the next sync inherits both. Repair the resolution instead:

```bash
# 1. Confirm which side is stale.
git diff --numstat "upstream/release/$TARGET" -- <file>
git show "upstream/release/$TARGET":<file> | grep -nE '^export'
# 2. Take upstream's file, then re-apply ONLY the fork feature on top,
#    using upstream's current names.
git checkout "upstream/release/$TARGET" -- <file>
```

Then re-verify with `pnpm tsgo` and `pnpm check:test-types` — the remaining
errors are the rest of the stale set, not new breakage. Fix them the same way.
A test file that is upstream-owned and carries no fork-feature assertions is
taken from upstream wholesale; one that carries fork coverage is rebuilt from
upstream's version with the fork's assertions re-added.

If a fork-touched file's guard, branch, or helper vanished during the merge,
restore it — a dropped upstream guard is a silent regression, not a cleanup.

#### Fork patches on upstream code (re-apply if Step 5f flags them)

Most fork features are fork-only _additions_ that a merge carries unchanged.
The two below instead _modify upstream-owned files_, so an upstream change can
silently revert them or cause a semantic conflict. If Step 5f reports either as
MISSING — or the merge conflicts in these files — re-apply the patch (do **not**
just delete the conflicting hunk), keep the fork-features.txt entry, then continue.
Both are deployed-behaviour bug fixes; dropping them re-breaks live agents.

1. **Ollama OpenAI-compat tool-call arguments must stay a STRING**
   - File: `extensions/ollama/src/stream.ts`, function `normalizeOllamaCompatMessageToolArgs`.
   - Contract: this function runs only on the `api: "openai-completions"` path
     (via `wrapOllamaCompatNumCtx`). Ollama's OpenAI endpoint requires
     `tool_calls[].function.arguments` (and legacy `function_call.arguments`) to be
     a **string** (stringified JSON). It must use the `ensureArgsString` helper,
     **never** `ensureArgsObject`. `ensureArgsObject`/`normalizeOllamaToolCallArguments`
     are correct only for the native `/api/chat` path (`convertToOllamaMessages`).
   - If upstream reverts it to `ensureArgsObject`, runs on cloud models like
     `glm-5.2:cloud` die with `400 ... cannot unmarshal object into Go struct field
.messages.tool_calls.function.arguments of type string` on the first turn that
     replays a prior tool call. (Deploy also carries a belt-and-suspenders config
     flag `models.providers.ollama.injectNumCtxForOpenAICompat: false`, but the code
     fix is the real resolution — keep it.)

2. **Sandbox skill prompts must use in-container paths, not host paths**
   - Files: `src/agents/embedded-agent-runner/sandbox-skills.ts` (helper
     `resolveEmbeddedRunSkillsPrompt`), wired in `run/attempt.ts`. As of 2026.7.2
     upstream owns this: the compaction side lives in
     `prepared-compaction-runtime.ts`, which composes `mapSandboxSkillEntriesForPrompt`
     directly, and `compact.ts` is now a thin facade with no skill wiring. Check the
     compaction path there, not in `compact.ts`.
   - Contract: for any enabled sandbox (**including `workspaceAccess: "rw"`**), the
     skills prompt must be rebuilt from freshly-loaded entries whose paths are
     remapped to the container copies (`mapSandboxSkillEntriesForPrompt`), never the
     host snapshot's absolute paths. `resolveSandboxSkillRuntimeInputs` already
     returns `skillsSnapshot: undefined` for every sandbox; both runners must feed
     that through the remapped entries.
   - If upstream re-inlines the old per-runner logic (the prior `sandboxNeedsOwnSkills`
     shape that excluded `rw`), sandboxed agents get an unreadable host path and the
     run fails with `Path escapes sandbox root ... /usr/lib/node_modules/openclaw/skills/.../SKILL.md`.

### Step 5g: Root package.json fork customizations

The host already pinned the root `version` to `{{TARGET_RELEASE}}` (the clean
release train, not the branch's `-beta`, so `OPENCLAW_SERVICE_VERSION` never reads
as a downgrade) and kept the fork's `deploy:globally` script, which the deploy
lane calls after `npm i -g`. If your conflict resolutions touched the root
`package.json`, confirm both survived:

```bash
node -e "const p=require('./package.json');console.log(p.version,p.scripts['deploy:globally'])"
```

> **Dependency versions are upstream's, not the fork's.** For any third-party
> dependency a conflict touches, **take upstream's version**; never re-pin the
> value the fork happened to carry. Upstream bumps deps because its own code needs
> the new API, so a "kept" older pin breaks the build in a way that looks
> unrelated: `@openclaw/fs-safe` 0.4.4 was correct for the pre-2026.7.2 base, and
> force-carrying it onto 2026.7.2 removed `configureFsSafeNative` and broke every
> import of `src/utils.ts`.
>
> Cross-check before accepting a pin: if an `extensions/*/package.json` asks for a
> newer version than root, root is the stale outlier, not the plugin.
> `grep -rn '<dep>' package.json extensions/*/package.json pnpm-workspace.yaml`
> should agree.

> The deploy lane (`scripts/sync-and-deploy.sh`, host step 8) separately handles
> the `@openai/codex` `workspace:*` install break (via
> `scripts/prepare-global-install-package-json.mjs`) and pins
> `OPENCLAW_CODEX_APP_SERVER_BIN` in the systemd unit (the fork bundles codex, so
> the managed-binary resolver misses the bundled binary and every openai model
> fails). No sync-agent action needed for those; they run at deploy time.

### Step 6: Commit fixups

The merge commit holds the conflict resolutions (Step 2–4). If install, build,
check, or fork-feature repair required more changes, commit them on top:

```bash
scripts/committer "chore/fix: <description>" <files...>
```

Remove `.tmp/` before committing. Never commit `.tmp/` or any scratch directory.

### Step 7: Publish — the host does this, not you

Do **not** run `git push`. This sandbox has no GitHub credentials. The host
publishes after checking your result: the merge must be committed, the tree
clean, `main` must contain both `upstream/release/{{TARGET_RELEASE}}` and
everything `origin/main` had, and the push is a plain fast-forward. Leave `main`
committed and clean, report `pushed: false`, and set `status` from steps 2–6
alone. On `status: "failed"` the host parks your work on
`sync/attempt-{{TARGET_RELEASE}}` and resets `main`, so leave the tree as it is
rather than undoing anything.

## Stop gates (set status: "failed" and stop)

1. A conflict where the fork's behaviour cannot be carried onto upstream's new
   code without guessing what one side meant.
2. A fork patch whose upstream premise was deleted but that fails one of the
   four checks in the conflict rules.
3. Build or typecheck failures you could not trace to a resolution and fix.
4. A fork feature that is **genuinely lost** (Step 5f case 1) and could not be
   re-applied. A MISSING line alone is not a stop gate — triage it first.

Not a stop gate: a MISSING fork feature that turned out to be moved, renamed, or
upstreamed (Step 5f cases 2 and 3). Fix `docs/fork-features.txt`, commit it, and
continue. Report the repointed entries in `notes`.

Not a stop gate: untracked files that were there before you started — these are
local-only additions.

Not a stop gate: `npm shrinkwrap guard` failing alone due to dual-major-version
packages — accept, note it, and continue.

Not a stop gate: a failed `git push`. You should not push at all (Step 7).

## When done

Emit a `<sync-result>` JSON object with these fields:

- `status`: `"success"` | `"partial"` | `"failed"`
  - `"success"`: steps 1–6 completed; `main` is ready for the host to publish
  - `"partial"`: ready to publish, but one or more non-blocking check lanes failed
  - `"failed"`: hit a stop gate — `main` must not be published
- `upstreamCommits`: `{{UPSTREAM_COMMITS}}` (from the host)
- `trackedRelease`: `"{{TARGET_RELEASE}}"`
- `conflicts`: `{{CONFLICTED}}` (files that conflicted when the host started the merge)
- `build`: `"passed"` | `"failed"` | `"skipped"`
- `tests`: `"passed"` | `"failed"` | `"skipped"`
- `forkFeatures`: `"verified"` | `"failed"` | `"skipped"`
- `pushed`: always `false` (you never push — see Step 7)
- `deployNeeded`: always `true` (step 8 requires sudo/systemd — cannot run here)
- `newUpstreamCommits`: (optional) new upstream commits that arrived during this run
- `failedCheckLanes`: (optional) array of lane names that failed in `pnpm check`
- `notes`: (optional) one-sentence summary of anything unusual

Example (success):

<sync-result>
{"status":"success","upstreamCommits":41,"trackedRelease":"2026.6.5","conflicts":3,"build":"passed","tests":"passed","forkFeatures":"verified","pushed":false,"deployNeeded":true}
</sync-result>

Example (shrinkwrap partial):

<sync-result>
{"status":"partial","upstreamCommits":41,"trackedRelease":"2026.6.5","conflicts":3,"build":"passed","tests":"skipped","forkFeatures":"verified","pushed":false,"deployNeeded":true,"failedCheckLanes":["npm shrinkwrap guard"],"notes":"@smithy packages have two major versions in pnpm-lock — shrinkwrap will self-resolve on next sync."}
</sync-result>
