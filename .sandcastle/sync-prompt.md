# Upstream Sync Task

You are running the upstream sync procedure defined in `docs/UPSTREAM-SYNC.md`.
Execute steps 1–7 (fetch through push). Step 8 (deploy) requires sudo and
systemd access — stop before it.

## Environment notes

- `pnpm` is **not** on PATH. Use `corepack pnpm` for every pnpm command.
- `pnpm install` was already run before you started (via `onSandboxReady`).
- Untracked files (`??` in `git status`) are local-only additions — ignore them
  when assessing working-tree cleanliness. Only unstaged changes to **tracked**
  files matter (`git diff HEAD`).

## Procedure

Follow `docs/UPSTREAM-SYNC.md` exactly. Key reminders per step:

### Step 2–4: Fetch + rebase onto the newest release branch

This fork tracks the newest upstream **release** branch (e.g. `release/2026.6.5`),
**not** `main`. `main` never carries version bumps — its `package.json` stays at a
baseline (e.g. `2026.6.2`) even as code lands — so the deployed version only
advances when we rebase onto release branches.

```bash
git fetch upstream --tags --prune

# Newest release branch by version. Only `release/X.Y.Z` names qualify:
# `release-ci/*` (hash-named CI snapshots) and any suffixed names are excluded,
# and `sort -V` orders the dotted versions correctly.
TARGET=$(git for-each-ref --format='%(refname:short)' 'refs/remotes/upstream/release/*' \
  | sed 's#^upstream/release/##' \
  | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' \
  | sort -V | tail -1)
echo "Newest release branch: upstream/release/$TARGET"

# Fork-only commits = everything in `main` not contained in ANY upstream ref.
# They form one contiguous chain at the tip of `main` (re-stacked every sync),
# so the base to replant from is the parent of the OLDEST fork commit — i.e. the
# upstream commit the stack currently sits on (last sync's release branch, or the
# old `upstream/main` tip on the first switch). Deriving the base this way needs
# no stored state and stays correct across both the first main→release switch and
# every later release→release bump.
#
# Do NOT use `git merge-base main upstream/main` here: once we track a release
# branch, that merge-base walks back to where the release line diverged from main
# and would drag the release branch's own commits into the rebase set.
FORK_COMMITS=$(git rev-list main --not --remotes=upstream)
if [ -n "$FORK_COMMITS" ]; then
  BASE=$(git rev-parse "$(echo "$FORK_COMMITS" | tail -1)^")
else
  BASE=$(git rev-parse main)   # no fork commits (unexpected) — nothing to replant
fi

# Count what the target release brings in over the current base (for the report).
NEW_COMMITS=$(git rev-list "$BASE..upstream/release/$TARGET" | wc -l | tr -d ' ')
echo "release/$TARGET adds $NEW_COMMITS commit(s) over current base $BASE"

git rebase --onto "upstream/release/$TARGET" "$BASE" main
```

**Already on the newest release is normal — and it's a fast exit.** If
`NEW_COMMITS` is `0` (the newest release branch is the one `main` already sits
on), the rebase is a no-op: the working tree is byte-identical to the last
successful sync that already built, checked, and pushed it. **Do not run
install/build/check** — there is nothing new to verify, and the full
optional-bundled build does not finish inside one agent turn, so polling it here
is what makes the run die with `codex exited with code 1` before it can emit this
result. Instead, confirm the tree is clean and already pushed, then report
success **immediately**:

```bash
# Guard: only short-circuit when the rebase truly changed nothing.
test -z "$(git status --porcelain --untracked-files=no)" \
  && git rev-list --count "origin/main..main" | grep -qx 0 \
  && echo "NO-OP: main == upstream/release/$TARGET and == origin/main — skipping build"
```

For a confirmed no-op, return `upstreamCommits: 0`, `conflicts: 0`,
`build: "skipped"`, `tests: "skipped"`, `forkFeatures: "skipped"`,
`pushed: true`, `status: "success"` (origin/main already matches local main; no
push needed). Only fall through to the full install/build/check/push path below
when `NEW_COMMITS` is greater than `0`.

Report `upstreamCommits: $NEW_COMMITS` and set `trackedRelease` to `$TARGET` (e.g.
`"2026.6.5"`) in the result.

### Conflict resolution rules

Apply these **in order**. The redundant-commit check comes first because it
resolves the large majority of stops on a release→release bump.

- **Redundant upstream commit — check this FIRST, before any merge.** The replay
  range `$BASE..main` is not only our fork patches; it includes every upstream
  commit that landed between syncs. The newer release branch already contains
  most of them, but git cannot auto-drop a redundant commit once an earlier
  replayed commit shifts its context, so it surfaces as a conflict (often a
  scary-looking semantic one). At every stop, test whether the commit being
  replayed is already in the release and skip it if so — do **not** hand-merge:
  ```bash
  git merge-base --is-ancestor "$(git rev-parse REBASE_HEAD)" \
    "upstream/release/$TARGET" && git rebase --skip
  ```
  A skipped redundant commit leaves the release's version in place, which already
  has its change. Only commits that are **not** ancestors of
  `upstream/release/$TARGET` are genuine fork patches worth merging by hand.
  (In the 2026.7.1 sync, 776 of 981 replayed commits were redundant. The stop-gate
  that failed the run — an iOS snapshot-test refactor — was one of them, already
  shipped in the release; it should have been skipped, not treated as semantic.)
- **pnpm-lock.yaml**: always accept upstream's version:
  `git checkout --theirs pnpm-lock.yaml && git add pnpm-lock.yaml && git rebase --continue`
- **Generated baselines** (`docs/.generated/*.sha256`): accept the release version:
  `git checkout "upstream/release/$TARGET" -- <file> && git add <file>`
- **Release-owned changelogs** (`CHANGELOG.md`, `apps/ios/CHANGELOG.md`): release
  generation owns these — accept the release version:
  `git checkout "upstream/release/$TARGET" -- <file> && git add <file>`
- **iOS release metadata the release no longer tracks**
  (`apps/ios/Config/Version.xcconfig`, `apps/ios/fastlane/metadata/*/release_notes.txt`):
  these are generated/gitignored upstream and show up as modify/delete — resolve
  by deleting: `git rm <file> && git rebase --continue`
- **GitHub Actions files** (`.github/workflows/`, `.github/actions/`, `.github/codeql/`,
  `.github/dependabot.yml`, `.github/actionlint.yaml`): this fork removes CI — always delete:
  `git rm <file> && git rebase --continue`
  After rebase also delete any new workflow files added by upstream (no conflict, just new):
  `git rm .github/workflows/*.yml .github/actions/ .github/codeql/ .github/dependabot.yml .github/actionlint.yaml 2>/dev/null || true`
- **Source code — trivial** (adjacent additions, import ordering, whitespace): resolve and continue.
- **Genuine fork-only source — semantic** (commit is NOT an ancestor of the
  release AND both sides changed the same logic differently): **stop gate** — set
  `status: "failed"` and report details. This applies only after the redundant
  check above rules the commit out; a "semantic" conflict on an already-released
  commit is not a stop gate, it is a skip.

### Step 5a: Install

Already done by `onSandboxReady`. If pnpm-lock.yaml changed during rebase, re-run:
```bash
CI=true corepack pnpm install --no-frozen-lockfile
```

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
to push — it is not a blocker.

### Step 5d: Tests (conflict-scoped)

Run tests only for files that had actual conflict resolutions. Skip if no source
files conflicted (pnpm-lock.yaml and workflow deletes don't count).

```bash
OPENCLAW_VITEST_MAX_WORKERS=4 corepack pnpm vitest run \
  <test-file-for-each-conflicted-source-file>
```

### Step 5f: Fork features

```bash
MISSING=0
while IFS='|' read -r pattern file desc; do
  pattern=$(echo "$pattern" | xargs); file=$(echo "$file" | xargs)
  if ! grep -qn "$pattern" "$file" 2>/dev/null; then
    echo "MISSING: $desc ($pattern in $file)"
    MISSING=1
  fi
done < <(grep -v '^#\|^$' docs/fork-features.txt)
[ "$MISSING" -eq 1 ] && echo "STOP: fork features missing"
```

If any are missing: **stop gate** — set `status: "failed"`.

#### Fork patches on upstream code (re-apply if Step 5f flags them)

Most fork features are fork-only *additions* that simply replant during rebase.
The two below instead *modify upstream-owned files*, so an upstream change can
silently revert them or cause a semantic conflict. If Step 5f reports either as
MISSING — or the rebase conflicts in these files — re-apply the patch (do **not**
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
     `resolveEmbeddedRunSkillsPrompt`), wired in `run/attempt.ts` and `compact.ts`.
   - Contract: for any enabled sandbox (**including `workspaceAccess: "rw"`**), the
     skills prompt must be rebuilt from freshly-loaded entries whose paths are
     remapped to the container copies (`mapSandboxSkillEntriesForPrompt`), never the
     host snapshot's absolute paths. `resolveSandboxSkillRuntimeInputs` already
     returns `skillsSnapshot: undefined` for every sandbox; both runners must feed
     that through `resolveEmbeddedRunSkillsPrompt`.
   - If upstream re-inlines the old per-runner logic (the prior `sandboxNeedsOwnSkills`
     shape that excluded `rw`), sandboxed agents get an unreadable host path and the
     run fails with `Path escapes sandbox root ... /usr/lib/node_modules/openclaw/skills/.../SKILL.md`.

### Step 6: Commit fixups

If install, build, check, or fork-feature repair required file changes, commit them:
```bash
scripts/committer "chore/fix: <description>" <files...>
```

Remove `.tmp/` before committing. Never commit `.tmp/` or any scratch directory.

### Step 7: Push

```bash
git push origin main --force-with-lease
```

## Stop gates (set status: "failed" and stop)

1. Semantic rebase conflicts where both sides changed the same logic differently.
2. `git rebase --abort` was needed — rebase could not be completed.
3. Build or typecheck failures after conflict resolution (may indicate bad merge).
4. Fork features missing after rebase (`docs/fork-features.txt` check failed).

Not a stop gate: untracked files (`??` in `git status`) — these are local-only
additions. Set `rebased: true` as long as `git diff HEAD` shows no unstaged
changes to tracked files and the rebase completed.

Not a stop gate: `npm shrinkwrap guard` failing alone due to dual-major-version
packages — accept, note it, and push.

## When done

Emit a `<sync-result>` JSON object with these fields:

- `status`: `"success"` | `"partial"` | `"failed"`
  - `"success"`: all steps completed, pushed
  - `"partial"`: pushed but one or more non-blocking check lanes failed
  - `"failed"`: hit a stop gate — did not push
- `upstreamCommits`: number of release-branch commits brought in (the `NEW_COMMITS`
  count from step 2–4; integer)
- `trackedRelease`: the release branch version this sync rebased onto, e.g.
  `"2026.6.5"` (string)
- `conflicts`: number of files that had merge conflicts (integer)
- `build`: `"passed"` | `"failed"` | `"skipped"`
- `tests`: `"passed"` | `"failed"` | `"skipped"`
- `forkFeatures`: `"verified"` | `"failed"` | `"skipped"`
- `pushed`: `true` if `git push --force-with-lease` succeeded **or origin/main already
  matches local main** ("Everything up to date" is still success); `false` only if a push
  was attempted and failed
- `deployNeeded`: always `true` (step 8 requires sudo/systemd — cannot run here)
- `newUpstreamCommits`: (optional) new upstream commits that arrived during this run
- `failedCheckLanes`: (optional) array of lane names that failed in `pnpm check`
- `notes`: (optional) one-sentence summary of anything unusual

Example (success):

<sync-result>
{"status":"success","upstreamCommits":41,"trackedRelease":"2026.6.5","conflicts":3,"build":"passed","tests":"passed","forkFeatures":"verified","pushed":true,"deployNeeded":true}
</sync-result>

Example (shrinkwrap partial):

<sync-result>
{"status":"partial","upstreamCommits":41,"trackedRelease":"2026.6.5","conflicts":3,"build":"passed","tests":"skipped","forkFeatures":"verified","pushed":true,"deployNeeded":true,"failedCheckLanes":["npm shrinkwrap guard"],"notes":"@smithy packages have two major versions in pnpm-lock — shrinkwrap will self-resolve on next sync."}
</sync-result>

Example (no-op — `main` already on the newest release; build/check skipped, see Step 2–4):

<sync-result>
{"status":"success","upstreamCommits":0,"trackedRelease":"2026.6.11","conflicts":0,"build":"skipped","tests":"skipped","forkFeatures":"skipped","pushed":true,"deployNeeded":true,"notes":"Already on newest upstream release and in sync with origin/main — no build/check needed."}
</sync-result>
