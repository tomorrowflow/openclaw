# Upstream Sync Howto

Repeatable procedure to sync this fork (`tomorrowflow/openclaw`) with the
upstream repo (`openclaw/openclaw`), verify the merge, and push.

Designed to be executed by Claude Code or followed manually.

---

## Prerequisites

- Node 22+, pnpm installed
- Git remote `upstream` pointing to `https://github.com/openclaw/openclaw.git`
- Working tree clean (`git status` shows nothing to commit).
  If there are unstaged changes, stash or discard them:
  `git stash push -m "WIP before sync"` or `git checkout -- .`

## 1. Setup upstream remote (first time only)

```bash
git remote add upstream https://github.com/openclaw/openclaw.git
```

## 2. Fetch upstream

```bash
git fetch upstream
```

## 3. Check divergence

```bash
# Our fork-only commits (not in upstream)
git log --oneline main --not upstream/main

# How many upstream commits we're missing
git log --oneline upstream/main --not main | wc -l

# Find the common ancestor
git merge-base main upstream/main
```

## 4. Rebase fork commits onto upstream

Rebase our fork-specific commits on top of the latest upstream/main.
This keeps a linear history with our changes on top.

```bash
MERGE_BASE=$(git merge-base main upstream/main)
git rebase --onto upstream/main "$MERGE_BASE" main
```

### Resolving conflicts

If the rebase stops with conflicts:

1. Check which files conflict: `git diff --name-only --diff-filter=U`
2. Open each file, find `<<<<<<<` markers, resolve by combining both sides
3. Stage resolved files: `git add <file>`
4. Continue: `git rebase --continue`
5. Repeat until all commits are replayed

**Common conflict patterns:**

- **Upstream refactors, fork adds logic.** Upstream restructures a function or
  extracts it into a new file while our fork adds parameters or branches.
  Resolution: keep upstream's structural changes AND our additions, adapting
  variable names and control flow to the new structure.

- **Upstream extracts code into a new module.** If upstream moves a function
  from `a.ts` to `b.ts` and our fork added code inside that function, the
  rebase may apply cleanly in `a.ts` (where the function no longer exists) but
  silently drop our addition. **After rebase, always verify our fork features
  are still present in the new locations** (see step 5f).

- **Lock file conflicts (`pnpm-lock.yaml`).** Always skip these with
  `git rebase --skip` — `pnpm install` regenerates the lock file.

- **Callback vs loop mismatch.** Upstream may refactor a `for...of` loop into
  a callback-based helper. Our `continue` statements become `return` in
  callbacks, and destructured parameter names may differ (e.g. `nowMs: now`).
  Match the upstream callback signature.

If a rebase goes badly: `git rebase --abort` returns to the pre-rebase state.

## 5. Verify the merge

### 5a. Install dependencies

```bash
pnpm install
```

### 5b. Build

```bash
pnpm build
```

Type errors here often indicate conflict resolution mistakes (e.g. using a
variable name from the old code that was renamed in upstream's refactor).

### 5c. Lint and format

```bash
pnpm check
```

If lint fails with formatting issues (e.g. `oxfmt`), auto-fix:

```bash
npx oxfmt <file>
```

If lint fails with code style issues (e.g. `curly` rule), fix manually and
commit the fix.

### 5d. Run targeted tests

Run tests only for files touched by our fork commits (much faster than the
full suite on resource-constrained machines):

```bash
# List files changed in our fork commits vs upstream
git diff --name-only upstream/main..main

# Run tests for affected areas
OPENCLAW_TEST_WORKERS=4 pnpm vitest run src/tts/ src/cron/ extensions/memory-lancedb/ src/tui/ src/shared/text/ src/gateway/ src/markdown/ src/agents/pi-embedded-runner/ src/agents/pi-embedded-helpers/ src/auto-reply/ src/cli/
```

Adjust the paths to match whatever our fork changes.

**Note:** The full test suite (`pnpm test`) runs 900+ test files across 3
vitest configs with worker splitting. On a 4-core/8GB machine this takes
30+ minutes. Use targeted tests for the sync workflow; run the full suite
as a nightly or pre-release check.

### 5e. (Optional) Full test suite

```bash
OPENCLAW_TEST_WORKERS=4 pnpm test
```

### 5f. Verify fork features survived the rebase

Upstream refactors can silently drop our code when functions move between
files. After rebase, spot-check that key fork features are still present:

```bash
# Bare [[tts]] tag detection (moved from tts.ts to tts-core.ts by upstream)
grep -n '\[\[tts\]\]' src/tts/tts-core.ts

# Kokoro TTS provider
grep -n 'kokoroTTS' src/tts/tts.ts

# Cron catch-up logic
grep -n 'catching up missed run' src/cron/service/jobs.ts

# Memory-lancedb storageOptions
grep -n 'storageOptions' extensions/memory-lancedb/config.ts

# Reasoning tag stripping in TUI formatters
grep -n 'stripReasoningTags' src/tui/tui-formatters.ts

# Reasoning tag stripping helper
grep -n 'stripReasoningTagsFromText' src/shared/text/reasoning-tags.ts

# CLI device ID display in devices list
grep -n 'deviceId' src/cli/devices-cli.ts

# Gateway reasoning tag stripping
grep -n 'stripReasoningTagsFromText' src/gateway/server-chat.ts

# Streaming partial tag stripping (prevents leaked <final>/<thinking> fragments)
grep -n 'stripTrailingPartialTag' src/agents/pi-embedded-subscribe.ts

# Error text partial tag stripping
grep -n 'stripTrailingPartialFinalTag' src/agents/pi-embedded-helpers/errors.ts

# Sandbox skill reload for sandboxed workspaces
grep -n 'sandboxNeedsOwnSkills' src/agents/pi-embedded-runner/compact.ts

# Code-span closedOnly option (supports partial tag stripping)
grep -n 'closedOnly' src/markdown/code-spans.ts

# Kokoro TTS in config schema
grep -n 'kokoro' src/config/zod-schema.core.ts

# CLI positional options fix (prevents gateway subcommand option shadowing)
grep -n 'enablePositionalOptions' src/cli/program/build-program.ts
```

If any of these are missing, the upstream refactor moved the surrounding code
and our additions were lost. Re-add them in the new location.

## 6. Commit any fixups

If build/lint/test required changes, commit them:

```bash
scripts/committer "fix: lint and test fixups after upstream sync" <files...>
```

## 7. Push to fork

Since we rebased, a force push is required:

```bash
git push origin main --force-with-lease
```

`--force-with-lease` is safer than `--force` because it refuses to push if
someone else has pushed to the remote since your last fetch.

## 8. Deploy (stop, install, restart)

Stop the running gateway, install from the local repo globally, and restart.

> **Global install must be a real copy, not a symlink.**
> npm 7+ defaults to symlinking local installs (`install-links=false`), which
> breaks when the gateway runs as a different user (e.g. `openclaw`) that cannot
> traverse the dev repo's home directory. Always pass `--install-links` to force
> a real copy. The install target is `$(npm root -g)/openclaw/` (typically
> `/usr/lib/node_modules/openclaw/`). Running `pnpm build` only updates the dev
> repo's `dist/`; the gateway will keep running old code until you also run the
> install command below. Skipping this step is the most common cause of "fix is
> in the code but gateway still uses the old behavior".

> **Cross-user systemctl:** The gateway runs as the `openclaw` user (UID 1001)
> via a user-level systemd service. When deploying from a different user (e.g.
> `frogger`), all `systemctl --user` and `journalctl --user` commands must be
> prefixed with `sudo -u openclaw XDG_RUNTIME_DIR=/run/user/$(id -u openclaw)`
> so they target the correct user session. Without `XDG_RUNTIME_DIR`, systemd
> cannot find the user bus and the commands fail with "Failed to connect to bus".

```bash
# Helper alias (optional, for readability)
OC_SYSTEMCTL="sudo -u openclaw XDG_RUNTIME_DIR=/run/user/$(id -u openclaw) systemctl --user"

# Stop the gateway
$OC_SYSTEMCTL stop openclaw-gateway.service

# Install from local repo globally — --install-links ensures a real copy
# (without it, npm 7+ creates a symlink to the dev repo which breaks
# cross-user access)
sudo npm i -g . --install-links

# Rebuild the Control UI (not included in `pnpm build`)
pnpm ui:build
sudo cp -r dist/control-ui "$(npm root -g)/openclaw/dist/control-ui"

# Verify the deploy target has the fresh build
ls -l "$(npm root -g)/openclaw/dist/reply-"*.js
# The timestamp should match your latest `pnpm build`
ls "$(npm root -g)/openclaw/dist/control-ui/index.html"
# Must exist — without it the web UI shows "Control UI assets not found"

# Verify installed version
openclaw --version

# Update the systemd unit's OPENCLAW_SERVICE_VERSION to match the new version.
# The gateway's resolveRuntimeServiceVersion() reads this env var at runtime —
# if it's stale, the web UI will show the old version even after a restart.
NEW_VER=$(node -p "require('$(npm root -g)/openclaw/package.json').version")
sed -i "s/OPENCLAW_SERVICE_VERSION=.*/OPENCLAW_SERVICE_VERSION=$NEW_VER/" \
  /home/openclaw/.config/systemd/user/openclaw-gateway.service
sed -i "s/Description=OpenClaw Gateway (v.*)/Description=OpenClaw Gateway (v$NEW_VER)/" \
  /home/openclaw/.config/systemd/user/openclaw-gateway.service
$OC_SYSTEMCTL daemon-reload

# Remove stale sandbox containers so they pick up new mounts/env vars.
# Skip this if the deploy only changes gateway logic (no sandbox changes).
docker rm -f $(docker ps -a --filter "name=openclaw-sbx" --format "{{.Names}}" 2>/dev/null) 2>/dev/null || true

# Restart the gateway
$OC_SYSTEMCTL start openclaw-gateway.service

# Wait for startup and verify (~35s on 4-core/8GB)
sleep 35
$OC_SYSTEMCTL status openclaw-gateway.service
ss -ltnp | grep 18789
```

### Check for duplicate plugin warnings

After deploy, verify no bundled extensions were accidentally duplicated
into the user config extensions dir (`~/.openclaw/extensions/`):

```bash
openclaw --version 2>&1 | grep -i 'duplicate plugin'
# Expected: no output. If a duplicate is reported, remove the copy from
# ~/.openclaw/extensions/<name> — the bundled version in
# $(npm root -g)/openclaw/extensions/ is sufficient.

# Also verify nothing lingering in the config extensions dir:
ls ~/.openclaw/extensions/
# Should only contain user-authored (non-bundled) extensions, if any.
```

The plugin discovery system scans both `plugins.load.paths` (e.g.
`~/.openclaw/extensions/`) and the bundled extensions dir. If the same
extension exists in both locations, the realpath dedup check fails (different
paths) and a "duplicate plugin id" warning is emitted.

The gateway takes ~35 seconds to fully initialize (signal-cli, tailscale,
memory-lancedb, webchat). Check the logs if the port isn't listening after
60 seconds:

```bash
sudo -u openclaw XDG_RUNTIME_DIR=/run/user/$(id -u openclaw) \
  journalctl --user -u openclaw-gateway.service -n 30 --no-pager
```

## 9. Verify final state

```bash
# Our commits should sit cleanly on top of upstream
git log --oneline main --not upstream/main

# Upstream should have no commits we're missing
git log --oneline upstream/main --not main | wc -l
# Expected: 0
```

## 10. Restore stashed work (if applicable)

If you stashed WIP changes in the prerequisites step:

```bash
git stash pop
```

Resolve any conflicts with the newly rebased code.

---

## Quick reference (copy-paste)

```bash
# Full sync in one go (abort on any failure)
OC_SYSTEMCTL="sudo -u openclaw XDG_RUNTIME_DIR=/run/user/$(id -u openclaw) systemctl --user" \
  && git fetch upstream \
  && MERGE_BASE=$(git merge-base main upstream/main) \
  && git rebase --onto upstream/main "$MERGE_BASE" main \
  && pnpm install \
  && pnpm build \
  && pnpm check \
  && OPENCLAW_TEST_WORKERS=4 pnpm vitest run src/tts/ src/cron/ extensions/memory-lancedb/ src/tui/ src/shared/text/ src/gateway/ src/markdown/ src/agents/pi-embedded-runner/ src/agents/pi-embedded-helpers/ src/auto-reply/ src/cli/ \
  && git push origin main --force-with-lease \
  && $OC_SYSTEMCTL stop openclaw-gateway.service \
  && sudo npm i -g . --install-links \
  && pnpm ui:build \
  && sudo cp -r dist/control-ui "$(npm root -g)/openclaw/dist/control-ui" \
  && ls -l "$(npm root -g)/openclaw/dist/reply-"*.js \
  && ls "$(npm root -g)/openclaw/dist/control-ui/index.html" \
  && NEW_VER=$(node -p "require('$(npm root -g)/openclaw/package.json').version") \
  && sed -i "s/OPENCLAW_SERVICE_VERSION=.*/OPENCLAW_SERVICE_VERSION=$NEW_VER/" /home/openclaw/.config/systemd/user/openclaw-gateway.service \
  && sed -i "s/Description=OpenClaw Gateway (v.*)/Description=OpenClaw Gateway (v$NEW_VER)/" /home/openclaw/.config/systemd/user/openclaw-gateway.service \
  && $OC_SYSTEMCTL daemon-reload \
  && docker rm -f $(docker ps -a --filter "name=openclaw-sbx" --format "{{.Names}}" 2>/dev/null) 2>/dev/null; true \
  && $OC_SYSTEMCTL start openclaw-gateway.service \
  && sleep 35 \
  && ss -ltnp | grep 18789
```

The `ls` steps after `npm i -g` are sanity checks: the `reply-*.js` timestamp
should match your latest `pnpm build` output, and `control-ui/index.html` must
exist. If the timestamps are stale, the deploy failed silently and the gateway
will still run old code. If `control-ui/` is missing, the web UI will show
"Control UI assets not found" — `pnpm build` does **not** include the UI;
`pnpm ui:build` + copy is a separate step.

**Note:** `--install-links` is required. Without it, npm 7+ creates a symlink
to the dev repo instead of copying, which breaks cross-user access.

Update the `pnpm vitest run` paths if our fork's changed files evolve.

---

## Troubleshooting

| Problem                                               | Fix                                                                                                                                                                                                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `git rebase` conflicts on every sync                  | Consider squashing fork commits into fewer logical units                                                                                                                                                                             |
| `pnpm-lock.yaml` conflict during rebase               | `git rebase --skip` — `pnpm install` regenerates it                                                                                                                                                                                  |
| `pnpm install` fails after rebase                     | Delete `node_modules` and retry: `rm -rf node_modules && pnpm install`                                                                                                                                                               |
| Build fails with unknown variable names               | Conflict resolution used old name; check upstream's renamed parameters                                                                                                                                                               |
| Tests fail on changed defaults                        | Our fork may override a default upstream changed; update test to match                                                                                                                                                               |
| Fork feature silently dropped after rebase            | Upstream moved the function to a new file; re-add our code there                                                                                                                                                                     |
| Lint errors in our code after upstream adds new rules | Fix the violations, commit as a separate fixup                                                                                                                                                                                       |
| Tests timeout or OOM                                  | Lower workers: `OPENCLAW_TEST_WORKERS=2` or run targeted tests only                                                                                                                                                                  |
| `--force-with-lease` rejected                         | Someone else pushed; `git fetch origin && git rebase origin/main` first                                                                                                                                                              |
| Gateway not listening after restart                   | Check logs: `journalctl --user -u openclaw-gateway.service -n 50`                                                                                                                                                                    |
| `sudo npm i -g` permission denied                     | Ensure sudo is available; the global prefix needs root                                                                                                                                                                               |
| Fix is in source but gateway uses old behavior        | `pnpm build` only updates `dist/` in the dev repo; the service loads from `$(npm root -g)/openclaw/dist/`. Run `sudo npm i -g . --install-links` to deploy, or `sudo cp -r dist/* "$(npm root -g)/openclaw/dist/"` for a quick patch |
| Web UI shows "Control UI assets not found"            | `pnpm ui:build && sudo cp -r dist/control-ui "$(npm root -g)/openclaw/dist/control-ui"`. The UI is **not** part of `pnpm build`; every `sudo npm i -g . --install-links` wipes `dist/` and you must rebuild+copy the UI separately   |
| A2UI bundle fails (`lit` not found)                   | `cd vendor/a2ui/renderers/lit && npm install --no-package-lock`                                                                                                                                                                      |
| A2UI bundle fails (`rolldown` not found)              | `pnpm add -wD rolldown@1.0.0-rc.5`, rebuild, then `pnpm remove -wD rolldown`                                                                                                                                                         |
| "duplicate plugin id detected" warning on startup     | A bundled extension was manually copied into `~/.openclaw/extensions/`. Remove the copy — bundled extensions are discovered automatically from `$(npm root -g)/openclaw/extensions/`                                                 |
| Web UI shows old version after deploy                 | The systemd unit has a stale `OPENCLAW_SERVICE_VERSION` env var. Update it with `sed` and `systemctl --user daemon-reload` (see step 8). The gateway reads this env var at runtime via `resolveRuntimeServiceVersion()`              |

---

## Sync history

| Date       | Upstream commits | Conflicts | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------- | ---------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-02-16 | 1446             | 4         | tts.ts, memory-lancedb/config.ts, cron/jobs.ts, tui-formatters.ts. Bare `[[tts]]` handler lost in upstream tts-core.ts extraction — re-added post-sync. pnpm-lock.yaml skipped.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 2026-02-19 | 463              | 0         | Clean rebase, no conflicts. Control UI rebuilt on first startup after deploy. All 108 targeted test files passed (959 tests).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2026-02-20 | 133              | 0         | Clean merge, no conflicts. All 110 targeted test files passed (979 tests). Version 2026.2.20 deployed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 2026-02-20 | 19               | 0         | Clean rebase, no conflicts. All 110 targeted test files passed (989 tests). Version 2026.2.20 deployed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 2026-02-21 | 83               | 3         | tui-formatters.ts, server-chat.ts, cron/timer.ts. A2UI bundling required manual `lit` + `rolldown` install. tts.ts `tmpdir()` → `resolvePreferredOpenClawTmpDir()`. All 111 targeted test files passed (1015 tests).                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 2026-02-21 | 211              | 2         | server-chat.ts + server-methods/chat.ts (upstream renamed reasoning tag stripping to `stripInlineDirectiveTagsForDisplay`), pnpm-lock.yaml (skipped). All 116 targeted test files passed (1050 tests). Deploy blocked by Node 20 (needs 22+).                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2026-02-23 | 1045             | 5         | tui-formatters.ts, server-methods/chat.ts, cron/ops.ts + timer.ts, .gitignore + pnpm-lock.yaml. Upstream extracted cron timeout into `resolveCronJobTimeoutMs`/`executeJobCoreWithTimeout` helpers; kept fork hardening (<=0 → default). Upstream's `stripInlineDirectiveTagsFromMessageForDisplay` replaced fork's `stripMessageContent`. All 329 targeted test files passed (2875 tests).                                                                                                                                                                                                                                                                         |
| 2026-02-24 | 381              | 1         | pnpm-lock.yaml only (resolved by accepting upstream version). Updated 2 upstream cron-tool tests to match fork anti-spoofing behavior (agentId override). All 432 targeted test files passed (3836 tests). Version 2026.2.24 deployed.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 2026-02-26 | 391              | 6         | memory-lancedb/package.json (openai version), 2× pnpm-lock.yaml (skipped), cron/timer.ts (upstream extracted `resolveCronJobTimeoutMs` to timeout-policy.ts), 3× UPSTREAM-SYNC.md. Fixups: tts.ts `tmpdir()` → `resolvePreferredOpenClawTmpDir()`, jobs.ts `nowMs` → `now`, timeout-policy test updated for fork hardening, memory-lancedb `autoCapture` default fixed, removed catch-up logic from `recomputeNextRunsForMaintenance` (handled by `runMissedJobs`). Deploy fix: `/tmp/openclaw-1001` needed `chmod 700`, config `secretMounts` key removed by `openclaw doctor --fix`. All 371 targeted test files passed (3454 tests). Version 2026.2.26 deployed. |
