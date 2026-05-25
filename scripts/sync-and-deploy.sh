#!/usr/bin/env bash
# Upstream sync + deploy pipeline.
# Runs every Monday and Thursday night via cron.
#
# Stages:
#   1. Codex agent (Docker) — fetch + rebase + conflict resolution
#   2. Host — pnpm install, build, check, fork-feature verification
#   3. Host — git push --force-with-lease
#   4. Host — deploy (stop → npm i -g → pnpm deploy:globally → restart)
#
# On any failure the script exits non-zero; later stages are skipped.
# Logs go to ~/logs/sync-YYYYMMDD-HHMMSS.log.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$HOME/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/sync-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG_FILE") 2>&1

cd "$REPO_DIR"

OC_UID=$(id -u openclaw)
OC_SYSTEMCTL="sudo -u openclaw XDG_RUNTIME_DIR=/run/user/$OC_UID systemctl --user"

step() { echo ""; echo "── $1 ──────────────────────────────────────────────────────────"; }

echo "=== OpenClaw upstream sync $(date) ==="
echo "    repo : $REPO_DIR"
echo "    log  : $LOG_FILE"

# ── 1. Rebase via Codex agent ──────────────────────────────────────────────
step "1/7  Rebase (Codex agent)"
npx tsx .sandcastle/sync.ts

# ── 2. Install ────────────────────────────────────────────────────────────
step "2/7  pnpm install"
corepack pnpm install --no-frozen-lockfile

# ── 3. Build ──────────────────────────────────────────────────────────────
step "3/7  pnpm build"
OPENCLAW_INCLUDE_OPTIONAL_BUNDLED=1 corepack pnpm build

# ── 4. Check (lint / types / shrinkwrap) ──────────────────────────────────
step "4/7  pnpm check"
# pnpm check spawns nested pnpm; create a shim so those spawns resolve.
mkdir -p .tmp/bin
printf '#!/bin/sh\nexec corepack pnpm "$@"\n' > .tmp/bin/pnpm
chmod +x .tmp/bin/pnpm
PATH="$(pwd)/.tmp/bin:$PATH" CI=true corepack pnpm check
rm -rf .tmp/

# ── 5. Fork features ──────────────────────────────────────────────────────
step "5/7  Fork feature verification"
MISSING=0
while IFS='|' read -r pattern file desc; do
  pattern=$(echo "$pattern" | xargs)
  file=$(echo "$file" | xargs)
  if ! grep -qn "$pattern" "$file" 2>/dev/null; then
    echo "  MISSING: $desc  ($pattern  in $file)"
    MISSING=1
  fi
done < <(grep -v '^#\|^$' docs/fork-features.txt)
if [ "$MISSING" -eq 1 ]; then
  echo "✗ Fork features missing — re-add them before deploying"
  exit 1
fi
echo "  ✓ All fork features present"

# ── 6. Push ───────────────────────────────────────────────────────────────
step "6/7  git push --force-with-lease"
git push origin main --force-with-lease

# ── 7. Deploy ─────────────────────────────────────────────────────────────
step "7/7  Deploy"

$OC_SYSTEMCTL stop openclaw-gateway.service

# Clear stale npm temp symlinks that block the atomic rename during install.
sudo rm -f "$(npm root -g)"/.openclaw-* 2>/dev/null || true

# Install from local repo globally — --install-links forces a real copy
# (without it npm 7+ creates a symlink, which breaks cross-user access).
sudo npm i -g . --install-links

# Copy externalized extensions, reinstall supergateway, rebuild Control UI.
corepack pnpm deploy:globally

# Sanity checks — timestamps must match the fresh build.
ls -l "$(npm root -g)/openclaw/dist/reply-"*.js
ls "$(npm root -g)/openclaw/dist/control-ui/index.html"

# Update OPENCLAW_SERVICE_VERSION in the systemd unit.
NEW_VER=$(node -p "require('$(npm root -g)/openclaw/package.json').version")
sudo -u openclaw sed -i \
  "s/OPENCLAW_SERVICE_VERSION=.*/OPENCLAW_SERVICE_VERSION=$NEW_VER/" \
  /home/openclaw/.config/systemd/user/openclaw-gateway.service
sudo -u openclaw sed -i \
  "s/Description=OpenClaw Gateway (v.*)/Description=OpenClaw Gateway (v$NEW_VER)/" \
  /home/openclaw/.config/systemd/user/openclaw-gateway.service
$OC_SYSTEMCTL daemon-reload

# Remove stale sandbox containers so they pick up new mounts/env vars.
docker rm -f \
  $(docker ps -a --filter "name=openclaw-sbx" --format "{{.Names}}" 2>/dev/null) \
  2>/dev/null || true

# Validate config + run doctor (safe changes proceed automatically).
sudo -u openclaw XDG_RUNTIME_DIR=/run/user/$OC_UID openclaw config validate 2>&1 || true
sudo -u openclaw XDG_RUNTIME_DIR=/run/user/$OC_UID openclaw doctor --fix 2>&1 || true

$OC_SYSTEMCTL start openclaw-gateway.service

# Poll up to 60 s for the gateway to start listening.
echo "  Waiting for gateway on :18789..."
for i in $(seq 1 12); do
  ss -ltnp | grep -q 18789 && break
  sleep 5
done

if ss -ltnp | grep -q 18789; then
  echo "  ✓ Gateway listening on :18789"
else
  echo "  ✗ Gateway not listening after 60s — check logs:"
  sudo -u openclaw XDG_RUNTIME_DIR=/run/user/$OC_UID \
    journalctl --user -u openclaw-gateway.service -n 40 --no-pager
  exit 1
fi

echo ""
echo "✓ Sync and deploy complete (v$NEW_VER)  —  $(date)"
echo "  Log: $LOG_FILE"
