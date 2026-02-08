# Upstream Sync Howto

Repeatable procedure to sync this fork (`tomorrowflow/openclaw`) with the
upstream repo (`openclaw/openclaw`), verify the merge, and push.

Designed to be executed by Claude Code or followed manually.

---

## Prerequisites

- Node 22+, pnpm installed
- Git remote `upstream` pointing to `https://github.com/openclaw/openclaw.git`
- Working tree clean (`git status` shows nothing to commit).
  If the formatter left unstaged changes after the last commit, reset them:
  `git checkout -- .`

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

**Common conflict pattern:** Upstream refactors a function while our fork adds
parameters or logic to the same function. Resolution: keep upstream's
structural changes AND our additions.

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
OPENCLAW_TEST_WORKERS=4 pnpm vitest run src/tts/ src/cron/ extensions/memory-lancedb/
```

Adjust the paths to match whatever our fork changes. To find them:

```bash
# List files changed in our fork commits vs upstream
git diff --name-only upstream/main..main
```

**Note:** The full test suite (`pnpm test`) runs 900+ test files across 3
vitest configs with worker splitting. On a 4-core/8GB machine this takes
30+ minutes. Use targeted tests for the sync workflow; run the full suite
as a nightly or pre-release check.

### 5e. (Optional) Full test suite

```bash
OPENCLAW_TEST_WORKERS=4 pnpm test
```

## 6. Commit any fixups

If lint/format required changes, commit them:

```bash
scripts/committer "fix: lint fixups after upstream sync" <files...>
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

```bash
# Stop the gateway
systemctl --user stop openclaw-gateway.service

# Install from local repo globally (needs sudo for /usr/lib/node_modules)
sudo npm i -g .

# Verify installed version
openclaw --version

# Restart the gateway
systemctl --user start openclaw-gateway.service

# Wait for startup and verify
sleep 15
systemctl --user status openclaw-gateway.service
ss -ltnp | grep 18789
```

The gateway takes ~15 seconds to fully initialize (signal-cli, tailscale,
memory-lancedb, webchat). Check the logs if the port isn't listening after
30 seconds:

```bash
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

---

## Quick reference (copy-paste)

```bash
# Full sync in one go (abort on any failure)
git fetch upstream \
  && MERGE_BASE=$(git merge-base main upstream/main) \
  && git rebase --onto upstream/main "$MERGE_BASE" main \
  && pnpm install \
  && pnpm build \
  && pnpm check \
  && OPENCLAW_TEST_WORKERS=4 pnpm vitest run src/tts/ src/cron/ extensions/memory-lancedb/ \
  && git push origin main --force-with-lease \
  && systemctl --user stop openclaw-gateway.service \
  && sudo npm i -g . \
  && systemctl --user start openclaw-gateway.service \
  && sleep 15 \
  && ss -ltnp | grep 18789
```

Update the `pnpm vitest run` paths if our fork's changed files evolve.

---

## Troubleshooting

| Problem                                               | Fix                                                                     |
| ----------------------------------------------------- | ----------------------------------------------------------------------- |
| `git rebase` conflicts on every sync                  | Consider squashing fork commits into fewer logical units                |
| `pnpm install` fails after rebase                     | Delete `node_modules` and retry: `rm -rf node_modules && pnpm install`  |
| Lint errors in our code after upstream adds new rules | Fix the violations, commit as a separate fixup                          |
| Tests timeout or OOM                                  | Lower workers: `OPENCLAW_TEST_WORKERS=2` or run targeted tests only     |
| `--force-with-lease` rejected                         | Someone else pushed; `git fetch origin && git rebase origin/main` first |
| Gateway not listening after restart                   | Check logs: `journalctl --user -u openclaw-gateway.service -n 50`       |
| `sudo npm i -g` permission denied                     | Ensure sudo is available; the global prefix needs root                  |
