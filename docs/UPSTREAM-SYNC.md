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

## Autonomous execution (YOLO mode)

This document is designed for autonomous (YOLO-mode) execution by Claude Code.
Everything proceeds automatically **except** at these stop-and-ask gates:

1. **Rebase conflicts that can't be auto-resolved** — semantic merges where both
   sides changed the same logic differently (step 4)
2. **Build or typecheck failures after conflict resolution** — may indicate a
   bad merge that needs human judgement (step 5b)
3. **Fork features missing after rebase** — the `docs/fork-features.txt` check
   found dropped code that needs manual re-addition (step 5f)
4. **Config schema changes** — upstream introduced changes that would alter
   `/home/openclaw/.openclaw` config in destructive ways (step 8a)
5. **Gateway fails to start after deploy** — port 18789 not listening after
   60 seconds (step 8)

Everything else (clean rebases, lock file regeneration, formatting fixups,
sandbox cleanup, version bumps) proceeds without asking.

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

- **Lock file conflicts (`pnpm-lock.yaml`).** Always accept upstream's version
  and continue — `pnpm install` regenerates the lock file:
  `git checkout --theirs pnpm-lock.yaml && git add pnpm-lock.yaml && git rebase --continue`

- **Callback vs loop mismatch.** Upstream may refactor a `for...of` loop into
  a callback-based helper. Our `continue` statements become `return` in
  callbacks, and destructured parameter names may differ (e.g. `nowMs: now`).
  Match the upstream callback signature.

If a rebase goes badly: `git rebase --abort` returns to the pre-rebase state.

### Autonomous (YOLO) conflict resolution policy

When running autonomously:

1. Try auto-resolution for each conflicting file.
2. For `pnpm-lock.yaml` conflicts: always accept upstream's version:
   ```bash
   git checkout --theirs pnpm-lock.yaml && git add pnpm-lock.yaml && git rebase --continue
   ```
3. For source files where both sides changed the same logic differently
   (semantic conflict, not just a clean add/remove), **stop and ask the
   operator** — do not guess at the intended merge.
4. For trivial conflicts (e.g. adjacent additions, import ordering, whitespace),
   resolve automatically and continue.

## 5. Verify the merge

### 5a. Install dependencies

```bash
pnpm install
```

This step is critical even when no `package.json` changed. Extensions like
`memory-lancedb` have their own `node_modules/` with pnpm symlinks into the
root `node_modules/.pnpm/` store. After a rebase that touches `pnpm-lock.yaml`
(even if resolved by accepting upstream's version), these symlinks may point to
stale or missing store entries. Running `pnpm install` regenerates the store and
all symlinks, ensuring extension native deps (e.g. `@lancedb/lancedb`) resolve
correctly.

### 5b. Build

```bash
OPENCLAW_INCLUDE_OPTIONAL_BUNDLED=1 pnpm build
```

The `OPENCLAW_INCLUDE_OPTIONAL_BUNDLED=1` flag is **required** on this server.
Without it, upstream's `optionalBundledClusters` list skips building multi-file
extensions (acpx, diagnostics-otel, diffs, googlechat, matrix, memory-lancedb,
msteams, nostr, tlon, twitch, whatsapp, zalouser). Those extensions end up
without `index.js` entry points in `dist/extensions/<name>/`, and the plugin
discovery security check rejects them with "extension entry escapes package
directory" (the actual error is ENOENT).

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

Run tests only for directories touched by our fork commits (much faster than
the full suite on resource-constrained machines):

```bash
# Auto-derive test directories from fork-changed files
TEST_DIRS=$(git diff --name-only upstream/main..main \
  | grep '\.test\.ts$\|\.ts$' | sed 's|/[^/]*$||' | sort -u \
  | grep -v '^docs\|^scripts\|^skills\|^Dockerfile')

OPENCLAW_VITEST_MAX_WORKERS=4 pnpm vitest run $TEST_DIRS
```

Adjust manually if the auto-derived list is too broad or misses a directory.

**Note:** The full test suite (`pnpm test`) runs 900+ test files across 3
vitest configs with worker splitting. On a 4-core/8GB machine this takes
30+ minutes. Use targeted tests for the sync workflow; run the full suite
as a nightly or pre-release check.

### 5e. (Optional) Full test suite

```bash
OPENCLAW_VITEST_MAX_WORKERS=4 pnpm test
```

### 5f. Verify fork features survived the rebase

Upstream refactors can silently drop our code when functions move between
files. After rebase, verify all fork features are still present using the
machine-readable checklist in `docs/fork-features.txt`:

```bash
MISSING=0
while IFS='|' read -r pattern file desc; do
  pattern=$(echo "$pattern" | xargs); file=$(echo "$file" | xargs)
  if ! grep -qn "$pattern" "$file" 2>/dev/null; then
    echo "MISSING: $desc ($pattern in $file)"
    MISSING=1
  fi
done < <(grep -v '^#\|^$' docs/fork-features.txt)
if [ "$MISSING" -eq 1 ]; then
  echo "STOP: fork features missing — re-add them in the new locations"
fi
```

If any features are missing, the upstream refactor moved the surrounding code
and our additions were lost. Re-add them in the new location.

**Maintenance:** update `docs/fork-features.txt` when adding or removing fork
features.

## 6. Commit any fixups

If build/lint/test required changes, commit them:

```bash
scripts/committer "fix: lint and test fixups after upstream sync" <files...>
```

If `pnpm install` changed `pnpm-lock.yaml`, commit it before pushing:

```bash
scripts/committer "chore: regenerate pnpm-lock.yaml after upstream sync" pnpm-lock.yaml
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

> **Two-user model.** The `frogger` user holds the source repo at
> `/home/frogger/openclaw/` and runs build/test/push. The `openclaw` user
> (UID 1001) runs the gateway service and owns its runtime config at
> `/home/openclaw/.openclaw/`. The global install at
> `$(npm root -g)/openclaw/` (typically `/usr/lib/node_modules/openclaw/`)
> is the bridge: `frogger` writes to it via `sudo npm i -g`, and `openclaw`
> reads from it at runtime.

> **Global install must be a real copy, not a symlink.**
> npm 7+ defaults to symlinking local installs (`install-links=false`), which
> breaks when the gateway runs as a different user (e.g. `openclaw`) that cannot
> traverse the dev repo's home directory. Always pass `--install-links` to force
> a real copy. Running `pnpm build` only updates the dev repo's `dist/`; the
> gateway will keep running old code until you also run the install command
> below. Skipping this step is the most common cause of "fix is in the code but
> gateway still uses the old behavior".

> **Cross-user systemctl:** The gateway runs as the `openclaw` user via a
> user-level systemd service. When deploying from `frogger`, all
> `systemctl --user` and `journalctl --user` commands must be prefixed with
> `sudo -u openclaw XDG_RUNTIME_DIR=/run/user/$(id -u openclaw)` so they
> target the correct user session. Without `XDG_RUNTIME_DIR`, systemd cannot
> find the user bus and the commands fail with "Failed to connect to bus".
> Similarly, `openclaw config validate`, `openclaw doctor --fix`, and
> `openclaw gateway restart` must run as the `openclaw` user to read/write
> the correct `~/.openclaw/` config directory.

> **Optional bundled extensions.** The build step **must** use
> `OPENCLAW_INCLUDE_OPTIONAL_BUNDLED=1`. Without it, upstream's
> `optionalBundledClusters` skips building multi-file extensions (googlechat,
> matrix, memory-lancedb, msteams, whatsapp, etc.). The global install will
> have `dist/extensions/<name>/` directories containing only manifests and no
> `index.js`, causing the plugin discovery security check to reject them.

```bash
# Helper alias (optional, for readability)
OC_SYSTEMCTL="sudo -u openclaw XDG_RUNTIME_DIR=/run/user/$(id -u openclaw) systemctl --user"

# Stop the gateway
$OC_SYSTEMCTL stop openclaw-gateway.service

# Build fresh before install — include optional bundled extensions
OPENCLAW_INCLUDE_OPTIONAL_BUNDLED=1 pnpm build

# Clean stale npm temp symlinks that block the install.
# npm renames the existing dir to .openclaw-<random> before replacing it.
# If a previous install (without --install-links) left a symlink with that
# name, the rename fails with ENOTDIR. Removing it first is always safe.
sudo rm -f "$(npm root -g)"/.openclaw-* 2>/dev/null || true

# Install from local repo globally — --install-links ensures a real copy
# (without it, npm 7+ creates a symlink to the dev repo which breaks
# cross-user access)
sudo npm i -g . --install-links

# Reinstall supergateway — the global install above can remove other
# global packages. supergateway bridges external HTTP MCP servers
# (dav, planka, lightrag) to stdio for the gateway's MCP subsystem.
sudo npm i -g supergateway

# Copy library extension source files to the global install.
# Some extensions (speech-core, image-generation-core, media-understanding-core)
# are library packages without openclaw.plugin.json manifests. The standard
# build pipeline skips them, but the facade runtime
# (loadBundledPluginPublicSurfaceModuleSync) resolves their runtime-api at
# dist/extensions/<name>/runtime-api.ts via jiti. Without this step, the
# gateway crashes with "Unable to resolve bundled plugin public surface
# speech-core/runtime-api.js".
GLOBAL_EXT="$(npm root -g)/openclaw/dist/extensions"
for name in image-generation-core media-understanding-core speech-core; do
  if [ -d "extensions/$name" ]; then
    sudo mkdir -p "$GLOBAL_EXT/$name"
    for src_file in extensions/$name/*.ts; do
      [[ "$src_file" =~ \.test\.|\.d\. ]] && continue
      [ -f "$src_file" ] && sudo cp "$src_file" "$GLOBAL_EXT/$name/"
    done
    [ -d "extensions/$name/src" ] && sudo cp -r "extensions/$name/src" "$GLOBAL_EXT/$name/"
  fi
done

# Install extension runtime deps in the global install.
# npm pack strips node_modules/ from extensions, so bundled plugins with
# their own dependencies (e.g. memory-lancedb needs @lancedb/lancedb) will
# fail at runtime with "Cannot find module" unless we install them here.
# NOTE: Extensions live under dist/extensions/ in the global install, not
# a top-level extensions/ directory.
for ext_pkg in "$GLOBAL_EXT"/*/package.json; do
  ext_dir=$(dirname "$ext_pkg")
  if jq -e '.dependencies // empty | length > 0' "$ext_pkg" >/dev/null 2>&1; then
    sudo npm install --omit=dev --ignore-scripts --prefix "$ext_dir" 2>/dev/null || true
  fi
done

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
sudo -u openclaw sed -i "s/OPENCLAW_SERVICE_VERSION=.*/OPENCLAW_SERVICE_VERSION=$NEW_VER/" \
  /home/openclaw/.config/systemd/user/openclaw-gateway.service
sudo -u openclaw sed -i "s/Description=OpenClaw Gateway (v.*)/Description=OpenClaw Gateway (v$NEW_VER)/" \
  /home/openclaw/.config/systemd/user/openclaw-gateway.service
$OC_SYSTEMCTL daemon-reload

# Remove stale sandbox containers so they pick up new mounts/env vars.
# Always clean — it's fast and avoids subtle stale-mount bugs.
docker rm -f $(docker ps -a --filter "name=openclaw-sbx" --format "{{.Names}}" 2>/dev/null) 2>/dev/null || true

# Restart the gateway
$OC_SYSTEMCTL start openclaw-gateway.service

# Poll for startup (up to 60s) instead of a fixed sleep
for i in $(seq 1 12); do ss -ltnp | grep -q 18789 && break; sleep 5; done
$OC_SYSTEMCTL status openclaw-gateway.service
ss -ltnp | grep 18789
```

### 8a. Validate config and check for schema changes

After install but before starting the gateway, validate the config and check
if upstream introduced config schema changes that affect the running environment.
All commands must run as the `openclaw` user so they read/write the correct
`/home/openclaw/.openclaw/` config directory:

```bash
# Validate config first — catches missing plugins, stale entries, schema mismatches
sudo -u openclaw XDG_RUNTIME_DIR=/run/user/$(id -u openclaw) \
  openclaw config validate 2>&1

# If config is invalid, try doctor --fix
sudo -u openclaw XDG_RUNTIME_DIR=/run/user/$(id -u openclaw) \
  openclaw doctor --fix 2>&1 || true
```

**Common config validation failures after sync:**

- **"extension entry escapes package directory"** — the build was run without
  `OPENCLAW_INCLUDE_OPTIONAL_BUNDLED=1`. Rebuild and redeploy.
- **"plugin not found: \<name\>"** — if the name is a bundled extension
  (signal, excalidraw, etc.), the build or install is broken. If the name is
  an external MCP service (dav, planka, lightrag), these are no longer plugins —
  they live in `mcp.servers` now. Remove stale references from `plugins.allow`,
  `plugins.entries`, and `plugins.slots`, then verify the service is configured
  under `mcp.servers` (see step 8b).
- **Missing required config properties** — upstream added new required fields
  to types like `ResolvedTtsConfig`. Update test fixtures and config stubs.

**YOLO gate:** stop and ask if `doctor --fix` reports destructive changes
(removing keys, changing defaults that affect running agents). Safe changes
(adding new optional keys, migrating deprecated names) proceed automatically.

### 8b. Verify MCP server connectivity

External MCP servers (dav, planka, lightrag) are connected via `supergateway`
stdio-to-HTTP bridges configured in `mcp.servers`. After deploy, verify they
still connect:

```bash
# Quick probe — each server should list tools without errors
for name in dav planka lightrag; do
  sudo -u openclaw XDG_RUNTIME_DIR=/run/user/$(id -u openclaw) \
    openclaw mcp list 2>&1 | grep -q "$name" && echo "$name: configured" || echo "$name: MISSING"
done
```

If MCP servers stop working after a sync, check:

- **supergateway still installed globally** — `which supergateway`. Reinstall
  with `sudo npm i -g supergateway` if missing (a `sudo npm i -g . --install-links`
  can remove other global packages).
- **URLs use `localhost`, not `host.docker.internal`** — the gateway spawns
  `supergateway` on the host, not inside the Docker sandbox. `host.docker.internal`
  only resolves inside containers. The sandbox agent calls MCP tools through the
  gateway, which handles subprocess management on the host side.
- **Bearer tokens** — `dav` requires `--oauth2Bearer <token>`. The token is
  stored in the `mcp.servers.dav.args` array in `openclaw.json`. If the dav
  container is recreated, verify the token matches:
  `docker inspect dav-mcp-server | grep BEARER_TOKEN`.
- **Sandbox tool policy** — `tools.sandbox.tools.allow` must be `["*"]` (or
  explicitly list every MCP tool name). MCP tool names come from the servers
  themselves (e.g. `list_calendars`, `mcp_kanban_card_manager`,
  `query_document`) and are not prefixed with the server name. An explicit
  allowlist that only names core tools will silently block all MCP tools.

**Background: plugin-to-MCP migration (2026-03-22).** The `dav`, `planka`,
and `lightrag` services were originally custom OpenClaw plugins installed in
`~/.openclaw/extensions/` with a `mcpUrl` config field. That field was never
part of the core codebase — it was consumed by the plugins' own code. After the
2026-03-21 sync, upstream's plugin loader changes made those custom plugins
incompatible, and the extension files had already been removed from disk.

The migration replaced them with standard `mcp.servers` entries using
`supergateway` as a stdio-to-HTTP bridge. This approach is forward-compatible:
when OpenClaw adds native `StreamableHTTPClientTransport` support, the
`supergateway` wrapper can be replaced with a direct `url` field in
`mcp.servers` — the config path stays the same.

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
# Expected: empty. External MCP services (dav, planka, lightrag) are
# configured in mcp.servers, NOT as extensions in this directory.
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
  && OPENCLAW_INCLUDE_OPTIONAL_BUNDLED=1 pnpm build \
  && pnpm check \
  && TEST_DIRS=$(git diff --name-only upstream/main..main | grep '\.test\.ts$\|\.ts$' | sed 's|/[^/]*$||' | sort -u | grep -v '^docs\|^scripts\|^skills\|^Dockerfile') \
  && OPENCLAW_VITEST_MAX_WORKERS=4 pnpm vitest run $TEST_DIRS \
  && grep -v '^#\|^$' docs/fork-features.txt | while IFS='|' read -r p f d; do p=$(echo "$p"|xargs); f=$(echo "$f"|xargs); grep -q "$p" "$f" 2>/dev/null || echo "MISSING: $d"; done \
  && git push origin main --force-with-lease \
  && $OC_SYSTEMCTL stop openclaw-gateway.service \
  && OPENCLAW_INCLUDE_OPTIONAL_BUNDLED=1 pnpm build \
  && sudo rm -f "$(npm root -g)"/.openclaw-* 2>/dev/null; true \
  && sudo npm i -g . --install-links \
  && sudo npm i -g supergateway \
  && GLOBAL_EXT="$(npm root -g)/openclaw/dist/extensions" \
  && for name in image-generation-core media-understanding-core speech-core; do if [ -d "extensions/$name" ]; then sudo mkdir -p "$GLOBAL_EXT/$name"; for f in extensions/$name/*.ts; do [[ "$f" =~ \.test\.|\.d\. ]] && continue; [ -f "$f" ] && sudo cp "$f" "$GLOBAL_EXT/$name/"; done; [ -d "extensions/$name/src" ] && sudo cp -r "extensions/$name/src" "$GLOBAL_EXT/$name/"; fi; done \
  && for ext_pkg in "$GLOBAL_EXT"/*/package.json; do ext_dir=$(dirname "$ext_pkg"); jq -e '.dependencies // empty | length > 0' "$ext_pkg" >/dev/null 2>&1 && sudo npm install --omit=dev --ignore-scripts --prefix "$ext_dir" 2>/dev/null || true; done \
  && pnpm ui:build \
  && sudo cp -r dist/control-ui "$(npm root -g)/openclaw/dist/control-ui" \
  && ls -l "$(npm root -g)/openclaw/dist/reply-"*.js \
  && ls "$(npm root -g)/openclaw/dist/control-ui/index.html" \
  && NEW_VER=$(node -p "require('$(npm root -g)/openclaw/package.json').version") \
  && sudo -u openclaw sed -i "s/OPENCLAW_SERVICE_VERSION=.*/OPENCLAW_SERVICE_VERSION=$NEW_VER/" /home/openclaw/.config/systemd/user/openclaw-gateway.service \
  && sudo -u openclaw sed -i "s/Description=OpenClaw Gateway (v.*)/Description=OpenClaw Gateway (v$NEW_VER)/" /home/openclaw/.config/systemd/user/openclaw-gateway.service \
  && $OC_SYSTEMCTL daemon-reload \
  && docker rm -f $(docker ps -a --filter "name=openclaw-sbx" --format "{{.Names}}" 2>/dev/null) 2>/dev/null; true \
  && $OC_SYSTEMCTL start openclaw-gateway.service \
  && for i in $(seq 1 12); do ss -ltnp | grep -q 18789 && break; sleep 5; done \
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

Test directories are auto-derived from the fork diff. The fork feature check
uses `docs/fork-features.txt` — update that file when adding/removing features.

---

## Troubleshooting

| Problem                                                | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git rebase` conflicts on every sync                   | Consider squashing fork commits into fewer logical units                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `pnpm-lock.yaml` conflict during rebase                | `git checkout --theirs pnpm-lock.yaml && git add pnpm-lock.yaml && git rebase --continue` — `pnpm install` regenerates it                                                                                                                                                                                                                                                                                                                                                           |
| `pnpm install` fails after rebase                      | Delete `node_modules` and retry: `rm -rf node_modules && pnpm install`                                                                                                                                                                                                                                                                                                                                                                                                              |
| Build fails with unknown variable names                | Conflict resolution used old name; check upstream's renamed parameters                                                                                                                                                                                                                                                                                                                                                                                                              |
| Tests fail on changed defaults                         | Our fork may override a default upstream changed; update test to match                                                                                                                                                                                                                                                                                                                                                                                                              |
| Fork feature silently dropped after rebase             | Upstream moved the function to a new file; re-add our code there                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Lint errors in our code after upstream adds new rules  | Fix the violations, commit as a separate fixup                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Tests timeout or OOM                                   | Lower workers: `OPENCLAW_VITEST_MAX_WORKERS=2` or run targeted tests only. Note: `OPENCLAW_TEST_WORKERS` was renamed to `OPENCLAW_VITEST_MAX_WORKERS` upstream (2026-03-30). The old env var is silently ignored. On machines with less than 24 GiB RAM the "constrained" memory band caps workers to 2 by default                                                                                                                                                                  |
| `--force-with-lease` rejected                          | Someone else pushed; `git fetch origin && git rebase origin/main` first                                                                                                                                                                                                                                                                                                                                                                                                             |
| Gateway not listening after restart                    | Check logs: `journalctl --user -u openclaw-gateway.service -n 50`                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `sudo npm i -g` permission denied                      | Ensure sudo is available; the global prefix needs root                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `ENOTDIR` on `sudo npm i -g . --install-links`         | A stale `.openclaw-*` symlink in `$(npm root -g)/` blocks npm's atomic rename. Remove it: `sudo rm -f "$(npm root -g)"/.openclaw-*` then retry the install                                                                                                                                                                                                                                                                                                                          |
| Fix is in source but gateway uses old behavior         | `pnpm build` only updates `dist/` in the dev repo; the service loads from `$(npm root -g)/openclaw/dist/`. Run `sudo npm i -g . --install-links` to deploy, or `sudo cp -r dist/* "$(npm root -g)/openclaw/dist/"` for a quick patch                                                                                                                                                                                                                                                |
| Web UI shows "Control UI assets not found"             | `pnpm ui:build && sudo cp -r dist/control-ui "$(npm root -g)/openclaw/dist/control-ui"`. The UI is **not** part of `pnpm build`; every `sudo npm i -g . --install-links` wipes `dist/` and you must rebuild+copy the UI separately                                                                                                                                                                                                                                                  |
| A2UI bundle fails (`lit` not found)                    | `cd vendor/a2ui/renderers/lit && npm install --no-package-lock`                                                                                                                                                                                                                                                                                                                                                                                                                     |
| A2UI bundle fails (`rolldown` not found)               | `pnpm add -wD rolldown@1.0.0-rc.5`, rebuild, then `pnpm remove -wD rolldown`                                                                                                                                                                                                                                                                                                                                                                                                        |
| "duplicate plugin id detected" warning on startup      | A bundled extension was manually copied into `~/.openclaw/extensions/`. Remove the copy — bundled extensions are discovered automatically from `$(npm root -g)/openclaw/extensions/`                                                                                                                                                                                                                                                                                                |
| Web UI shows old version after deploy                  | The systemd unit has a stale `OPENCLAW_SERVICE_VERSION` env var. Update it with `sed` and `systemctl --user daemon-reload` (see step 8). The gateway reads this env var at runtime via `resolveRuntimeServiceVersion()`                                                                                                                                                                                                                                                             |
| Extension module not found (e.g. `@lancedb/lancedb`)   | Extension `node_modules/` contains pnpm symlinks into the root `.pnpm/` store. After rebase, these may dangle. Fix: `pnpm install` (step 5a). For the global install, ensure `--install-links` was used — without it, npm preserves the symlinks which break outside the dev repo                                                                                                                                                                                                   |
| "extension entry escapes package directory" on startup | Build was run without `OPENCLAW_INCLUDE_OPTIONAL_BUNDLED=1`. Multi-file extensions (googlechat, matrix, memory-lancedb, etc.) are in `optionalBundledClusters` and skipped without this flag. Rebuild with the flag and redeploy                                                                                                                                                                                                                                                    |
| "plugin not found" in config validation                | For bundled extensions: build or install is broken. For external MCP services (dav, planka, lightrag): these are no longer plugins — remove from `plugins.allow`/`plugins.entries`/`plugins.slots` and verify they are configured under `mcp.servers` with supergateway (see step 8b)                                                                                                                                                                                               |
| `openclaw config validate` sees wrong config           | Running as `frogger` reads `/home/frogger/.openclaw/`, not the gateway's config. Always run config/doctor commands as: `sudo -u openclaw XDG_RUNTIME_DIR=/run/user/$(id -u openclaw) openclaw config validate`                                                                                                                                                                                                                                                                      |
| Deploy breaks the gateway (won't start)                | Rollback: `$OC_SYSTEMCTL stop openclaw-gateway.service && git checkout <last-known-good-tag> && OPENCLAW_INCLUDE_OPTIONAL_BUNDLED=1 pnpm build && sudo npm i -g . --install-links && $OC_SYSTEMCTL start openclaw-gateway.service`                                                                                                                                                                                                                                                  |
| MCP tools not visible to sandbox agent                 | `tools.sandbox.tools.allow` must include MCP tool names or use `["*"]`. MCP tools use their own names (e.g. `list_calendars`), not the server name. An explicit allowlist of core tools silently blocks all MCP tools                                                                                                                                                                                                                                                               |
| MCP server "Connection closed" with ENOTFOUND          | URLs in `mcp.servers` use `host.docker.internal` but the gateway runs on the host. Change to `localhost` — the Docker containers expose their ports to the host                                                                                                                                                                                                                                                                                                                     |
| MCP server "Unauthorized: Bearer token required"       | The MCP server requires auth. Add `--oauth2Bearer <token>` to the supergateway args. Check the container env: `docker inspect <container> \| grep BEARER_TOKEN`                                                                                                                                                                                                                                                                                                                     |
| `supergateway` command not found after deploy          | `sudo npm i -g . --install-links` can remove other global packages. Reinstall: `sudo npm i -g supergateway`                                                                                                                                                                                                                                                                                                                                                                         |
| "Unable to resolve bundled plugin public surface"      | Library extensions (`speech-core`, `image-generation-core`, `media-understanding-core`) have no `openclaw.plugin.json` manifest so the build pipeline skips them. The facade runtime resolves them via `dist/extensions/<name>/runtime-api.ts` using jiti. Copy source files: `sudo mkdir -p "$GLOBAL_EXT/$name" && sudo cp extensions/$name/*.ts "$GLOBAL_EXT/$name/" && sudo cp -r extensions/$name/src "$GLOBAL_EXT/$name/"`. See the deploy step 8 library extension copy block |
| Lint false positives from stale dirs outside repo      | The `resolveRepoRoot` helper goes two dirs up from `scripts/lib/`; some lint scripts pass their own `import.meta.url` from `scripts/` (one level deep), resolving to the parent of the repo. If stale directories (e.g. `/home/frogger/extensions/`) exist at that path, lint flags phantom files. Remove the stale directory                                                                                                                                                       |
| Config invalid: "Unrecognized key" after sync          | Upstream refactored config schema (e.g. individual TTS provider keys replaced by generic `providers` map). Run `sudo -u openclaw ... openclaw doctor --fix` to remove stale keys. YOLO gate: stop and ask if doctor reports destructive changes                                                                                                                                                                                                                                     |

---

## Sync history

| Date       | Upstream commits | Conflicts | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------- | ---------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-02-16 | 1446             | 4         | tts.ts, memory-lancedb/config.ts, cron/jobs.ts, tui-formatters.ts. Bare `[[tts]]` handler lost in upstream tts-core.ts extraction — re-added post-sync. pnpm-lock.yaml skipped.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 2026-02-19 | 463              | 0         | Clean rebase, no conflicts. Control UI rebuilt on first startup after deploy. All 108 targeted test files passed (959 tests).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 2026-02-20 | 133              | 0         | Clean merge, no conflicts. All 110 targeted test files passed (979 tests). Version 2026.2.20 deployed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 2026-02-20 | 19               | 0         | Clean rebase, no conflicts. All 110 targeted test files passed (989 tests). Version 2026.2.20 deployed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 2026-02-21 | 83               | 3         | tui-formatters.ts, server-chat.ts, cron/timer.ts. A2UI bundling required manual `lit` + `rolldown` install. tts.ts `tmpdir()` → `resolvePreferredOpenClawTmpDir()`. All 111 targeted test files passed (1015 tests).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 2026-02-21 | 211              | 2         | server-chat.ts + server-methods/chat.ts (upstream renamed reasoning tag stripping to `stripInlineDirectiveTagsForDisplay`), pnpm-lock.yaml (skipped). All 116 targeted test files passed (1050 tests). Deploy blocked by Node 20 (needs 22+).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 2026-02-23 | 1045             | 5         | tui-formatters.ts, server-methods/chat.ts, cron/ops.ts + timer.ts, .gitignore + pnpm-lock.yaml. Upstream extracted cron timeout into `resolveCronJobTimeoutMs`/`executeJobCoreWithTimeout` helpers; kept fork hardening (<=0 → default). Upstream's `stripInlineDirectiveTagsFromMessageForDisplay` replaced fork's `stripMessageContent`. All 329 targeted test files passed (2875 tests).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 2026-02-24 | 381              | 1         | pnpm-lock.yaml only (resolved by accepting upstream version). Updated 2 upstream cron-tool tests to match fork anti-spoofing behavior (agentId override). All 432 targeted test files passed (3836 tests). Version 2026.2.24 deployed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 2026-02-26 | 391              | 6         | memory-lancedb/package.json (openai version), 2× pnpm-lock.yaml (skipped), cron/timer.ts (upstream extracted `resolveCronJobTimeoutMs` to timeout-policy.ts), 3× UPSTREAM-SYNC.md. Fixups: tts.ts `tmpdir()` → `resolvePreferredOpenClawTmpDir()`, jobs.ts `nowMs` → `now`, timeout-policy test updated for fork hardening, memory-lancedb `autoCapture` default fixed, removed catch-up logic from `recomputeNextRunsForMaintenance` (handled by `runMissedJobs`). Deploy fix: `/tmp/openclaw-1001` needed `chmod 700`, config `secretMounts` key removed by `openclaw doctor --fix`. All 371 targeted test files passed (3454 tests). Version 2026.2.26 deployed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 2026-03-01 | 335              | 4         | 3× memory-lancedb (config.ts, index.ts, openclaw.plugin.json — merged fork `dimensions` support with upstream Ollama/S3/MinIO features), pnpm-lock.yaml (accepted upstream). Fixups: `@grammyjs/types` bumped from `^3.24.0` to `^3.25.0` to align with `grammy@1.41.0` (duplicate types caused build failure). Added extension deps install step to deploy (`npm install --omit=dev` in each global extension dir — `npm pack` strips `node_modules/`). Version 2026.2.27 deployed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 2026-03-04 | 1317             | 10        | types.tts.ts + tts.ts (merged upstream SecretInput import + buildTtsFailureResult with fork kokoro provider), memory-lancedb/index.ts (merged storageOptions + dimensions params), 2× pi-embedded-runner compact.ts + attempt.ts (upstream extracted `resolveEmbeddedRunSkillEntries` helper; kept fork sandbox-specific skill reload logic), cron-tool.ts (kept fork permissive Type.Object schema over upstream CronJobSchema), server-chat.ts (merged upstream delta flush with fork rawText reasoning-tag stripping), cron service.issue-regressions.test.ts (sync makeStorePath signature), cron isolated-agent/run.ts (merged upstream bootstrap warning signatures + fork senderIsOwner), 2× sandbox docker.ts + browser.ts (merged upstream appendWorkspaceMountArgs helper with fork shared/media/browser-home mounts), pnpm-lock.yaml (accepted upstream). Fixups: unused CronJobSchema prefixed, format fixes. All 847 targeted test files run (7331 tests passed; 7 pre-existing upstream failures). Version 2026.3.3 deployed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 2026-03-14 | 2152             | 10        | tts.ts (merged upstream resolveTtsRequestSetup helper with fork kokoroTTS function), jobs.ts (kept fork catch-up-after-restart logic inside upstream walkSchedulableJobs callback), pi-embedded-helpers/errors.ts (merged upstream classifyFailoverReasonFromHttpStatus with fork stripTrailingPartialFinalTag), server-chat.ts (merged upstream flushBufferedChatDeltaIfNeeded helper with fork rawText reasoning-tag stripping; fixed text redeclaration), ops.ts (merged upstream normalizeCronCreateDeliveryInput with fork per-agent job count limit), isolated-agent/run.ts (kept upstream interim-ack retry + senderIsOwner; fork duplicate dropped), command-auth.ts (upstream already includes ownerAllowAll in senderIsOwner via senderIsOwnerByScope), media-understanding/providers/index.test.ts (merged upstream minimax-portal + fork whisper-asr tests), pnpm-lock.yaml (accepted upstream), 7× GitHub workflow modify/delete (fork removes CI workflows). Fixups: jobs.ts indentation, server-chat.ts text redeclaration, format fixes. 959 targeted test files run (6262 tests passed; 124 pre-existing upstream failures from missing loadWorkspaceSkillEntries mock).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 2026-03-15 | 136              | 3         | pnpm-lock.yaml (accepted upstream), 2× GitHub workflow modify/delete (docker-release.yml, ci.yml + workflow-sanity.yml — fork removes CI workflows). No source code conflicts. All fork features verified present. 917 targeted test files passed (8662 tests); 57 pre-existing upstream failures (missing resolveModelAsync/loadWorkspaceSkillEntries mocks, CronPattern validation, environment-specific vault/symlink issues). Version 2026.3.14 deployed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 2026-03-30 | 2705             | 12        | 5× TTS files (commands-tts.ts, types.tts.ts, zod-schema.core.ts, provider-registry.ts, tts.ts — upstream refactored TTS into plugin-based provider registry; kept upstream's generic provider map, moved fork kokoro to src/tts/providers/kokoro.ts as built-in SpeechProviderPlugin), memory-lancedb/index.ts (upstream renamed loadLanceDB→loadLanceDbModule; kept fork storageOptions), tts-core.ts (upstream moved parseTtsDirectives to directives.ts; re-added bare [[tts]] tag to new location), cron-tool.test.ts (upstream renamed createCronTool→createTestCronTool; kept fork anti-spoofing assertion), sandbox/browser.ts (upstream moved imports to plugin-sdk/browser-runtime.js; kept fork fs/path/STATE_DIR imports, fixed STATE_DIR path config.js→paths.js), media-understanding/provider-registry.ts (upstream+fork both adding whisper-asr; kept upstream's BUILTIN_PROVIDERS pattern), openai/index.test.ts (removed fork's legacy per-provider config fixtures; upstream uses providerConfigs map), tsdown-build.mjs (upstream renamed extensions/→BUNDLED_PLUGIN_PATH_PREFIX), pnpm-lock.yaml (accepted upstream), 2× GitHub workflow modify/delete (docker-release.yml, 7× remaining workflows — fork removes CI). Fixups: whisper-asr/audio.ts import path ../shared.js→../../shared.js, tts.ts restored to upstream's thin re-export facade (was accidentally bloated by --theirs during curly-brace lint conflict), kokoro.ts rewritten for new SpeechProviderPlugin API (providerConfig/providerOverrides instead of config.kokoro), kokoro registered as built-in in provider-registry.ts, provider-registry.test.ts updated to expect kokoro in provider list, fork-features.txt updated for new file locations. Pre-deploy: removed stale /home/frogger/extensions/ (old custom plugins from pre-MCP-migration era causing lint false positives via resolveRepoRoot path mismatch). Config fix: doctor --fix removed stale messages.tts.kokoro key. Discovered OPENCLAW_TEST_WORKERS env var renamed to OPENCLAW_VITEST_MAX_WORKERS upstream (22 GiB RAM = "constrained" band = 2 workers default). Version 2026.3.29 deployed. |
| 2026-03-21 | 1658             | 4         | media-understanding/providers/index.ts (merged upstream mergeProviderIntoRegistry helper with fork whisper-asr provider), media-understanding/providers/index.test.ts (kept fork whisper-asr test, dropped moonshot/minimax-portal tests for non-existent providers), tts.ts (kept upstream resolveReadySpeechProvider pattern, removed fork inline kokoro/edge handling now handled by providers/kokoro.ts), pi-embedded-runner/compact.ts (removed duplicate loadWorkspaceSkillEntries import, kept truncateSessionAfterCompaction), 2× GitHub workflow modify/delete (ci.yml + install-smoke.yml). Fixups: added kokoro property to openai extension test fixture, excluded node_modules from UNRESOLVED_IMPORT build guard (jimp/baileys), fixed curly lint in kokoro.ts, removed unused kokoroTTS function. TTS/media provider tests all pass (79 tests); cron failures are pre-existing upstream. Deploy: discovered `OPENCLAW_INCLUDE_OPTIONAL_BUNDLED=1` is required — without it, multi-file extensions (googlechat, matrix, memory-lancedb, etc.) lack `index.js` entry points and plugin discovery rejects them. Cleaned stale plugin config references (archon, planka, lightrag, dav). Extension deps path corrected to `dist/extensions/`. Post-deploy: migrated dav/planka/lightrag from custom `~/.openclaw/extensions/` plugins (removed from disk, `mcpUrl` config field never in core) to `mcp.servers` entries using `supergateway` stdio-to-HTTP bridge (`sudo npm i -g supergateway`). Fixed URLs from `host.docker.internal` to `localhost` (gateway runs on host, not Docker). Added `--oauth2Bearer` for dav auth. Set `tools.sandbox.tools.allow` to `["*"]` so MCP tool names pass sandbox policy filter. Added nemotron-3-super:cloud model with `nemotron` alias. Version 2026.3.14 deployed.                                                                                                                                                                                                                                                                                                                                     |
