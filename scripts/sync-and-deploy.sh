#!/usr/bin/env bash
# Upstream sync + deploy pipeline.
# Runs every Monday and Thursday night from frogger's crontab.
#
# Stages:
#   1. Codex agent (Docker) — fetch, rebase, conflict resolution, install,
#      build, check, fork-feature verification, git push  (steps 1–7)
#   2. Host — deploy: stop → npm i -g → pnpm deploy:globally → restart  (step 8)
#      (deploy requires sudo/systemd — cannot run inside the Docker sandbox)
#
# On any failure the script exits non-zero; deploy is skipped and a Signal
# alert is sent (failure only — no message on success).
# Logs go to ~/logs/sync-YYYYMMDD-HHMMSS.log.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$HOME/logs"

# Where failure alerts go. openclaw runs as the openclaw user, so the send is
# wrapped in `sudo -u openclaw`. Signal target is an E.164 number.
NOTIFY_CHANNEL="signal"
NOTIFY_TARGET="+491755252288"

mkdir -p "$LOG_DIR"

# ── Single-instance guard ──────────────────────────────────────────────────
# A hung build must not let the next cron run overlap (two concurrent
# rebases/force-pushes would corrupt the branch). Done before the log+trap
# setup so a skipped run leaves no empty log and triggers no alert.
exec 9>"$LOG_DIR/.sync.lock"
if ! flock -n 9; then
  echo "[sync] another run holds the lock — exiting"
  exit 0
fi

LOG_FILE="$LOG_DIR/sync-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG_FILE") 2>&1

cd "$REPO_DIR"

OC_UID=$(id -u openclaw)
OC_SYSTEMCTL="sudo -u openclaw XDG_RUNTIME_DIR=/run/user/$OC_UID systemctl --user"

# Tracks the current phase so the failure alert can say where it broke.
STAGE="startup"

# Send a Signal alert as the openclaw user. Best-effort: if the gateway is down
# (e.g. a deploy failure between stop and restart) the send will fail and we
# just log it — the per-run log file remains the source of truth.
notify_failure() {
  local rc="$1"
  local msg="⚠ OpenClaw sync FAILED on $(hostname) — stage: ${STAGE} (exit ${rc}). Log: ${LOG_FILE}"
  echo "$msg"
  sudo -u openclaw XDG_RUNTIME_DIR="/run/user/$OC_UID" \
    openclaw message send --channel "$NOTIFY_CHANNEL" --target "$NOTIFY_TARGET" \
    --message "$msg" 2>&1 | tail -3 || echo "[sync] (alert send failed — gateway may be down)"
}

# Fire the alert on any non-zero exit. flock-skip above exits 0 (no alert).
trap 'rc=$?; [ "$rc" -ne 0 ] && notify_failure "$rc"' EXIT

step() { echo ""; echo "── $1 ──────────────────────────────────────────────────────────"; }

echo "=== OpenClaw upstream sync + deploy  $(date) ==="
echo "    repo : $REPO_DIR"
echo "    log  : $LOG_FILE"

# ── 1. Sync via Codex agent ────────────────────────────────────────────────
# The agent handles steps 1–7: fetch → rebase → install → build → check →
# fork-feature verification → push.  Exits 1 on non-success.
STAGE="sync (Codex agent, steps 1–7)"
step "1/2  Sync (Codex agent — steps 1–7)"
npx tsx .sandcastle/sync.ts

# ── 2. Deploy ─────────────────────────────────────────────────────────────
STAGE="deploy: stop gateway"
step "2/2  Deploy (host — step 8)"

$OC_SYSTEMCTL stop openclaw-gateway.service

# Clear stale npm temp symlinks that block the atomic rename during install.
sudo rm -f "$(npm root -g)"/.openclaw-* 2>/dev/null || true

# Install from local repo globally — --install-links forces a real copy
# (without it npm 7+ creates a symlink, which breaks cross-user access).
STAGE="deploy: npm i -g"
sudo npm i -g . --install-links

# Copy externalized extensions, reinstall supergateway, rebuild Control UI.
# CI=true keeps pnpm non-interactive: the Control UI rebuild (scripts/ui.js)
# may run `pnpm install`, which can hit pnpm's "remove modules and reinstall
# from scratch? (Y/n)" purge prompt. Under cron (no TTY) that would hang/fail;
# CI mode makes pnpm auto-proceed.
STAGE="deploy: pnpm deploy:globally"
CI=true corepack pnpm deploy:globally

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

# Validate config + run doctor. --non-interactive applies safe migrations only
# and never prompts (a destructive config change would otherwise block here
# waiting for confirmation, hanging the unattended cron with the gateway down).
# If a skipped destructive migration leaves the gateway unable to start, the
# health check below catches it and the failure alert fires.
sudo -u openclaw XDG_RUNTIME_DIR=/run/user/$OC_UID openclaw config validate 2>&1 || true
sudo -u openclaw XDG_RUNTIME_DIR=/run/user/$OC_UID openclaw doctor --fix --non-interactive 2>&1 || true

STAGE="deploy: gateway restart"
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
  STAGE="deploy: gateway not listening after restart"
  exit 1
fi

echo ""
echo "✓ Sync and deploy complete (v$NEW_VER)  —  $(date)"
echo "  Log: $LOG_FILE"
