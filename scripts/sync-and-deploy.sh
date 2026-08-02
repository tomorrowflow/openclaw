#!/usr/bin/env bash
# Upstream sync + deploy pipeline.
# Runs every Monday and Thursday night from frogger's crontab.
#
# Stages:
#   1. Codex agent (Docker) — fetch, rebase, conflict resolution, install,
#      build, check, fork-feature verification, git push  (steps 1–7)
#   2. Host — deploy (step 8): npm i -g → pnpm deploy:globally → cutover restart.
#      The gateway keeps serving the current version through install + bundle +
#      migrations, so a failure there leaves the live service UP (old version).
#      Only the final restart cuts over; the EXIT trap restores a running
#      gateway if a cutover failure left it down.
#      (deploy requires sudo/systemd — cannot run inside the Docker sandbox)
#
# On any failure the script exits non-zero; the deploy is skipped (sync stage)
# or the gateway is restored (deploy stage), and a Signal alert is sent
# (failure only — no message on success).
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

# Set to 1 only once the deploy reaches the cutover (gateway restart). Until
# then the gateway is never stopped, so a pre-cutover failure leaves it running
# and needs no restore. After cutover the EXIT trap uses this to bring it back.
GATEWAY_TOUCHED=0

# Send a Signal alert as the openclaw user. Best-effort: runs after
# restore_gateway_if_down, but if the gateway still cannot come up the send
# fails and we just log it — the per-run log file remains the source of truth.
notify_failure() {
  local rc="$1"
  local msg="⚠ OpenClaw sync FAILED on $(hostname) — stage: ${STAGE} (exit ${rc}). Log: ${LOG_FILE}"
  echo "$msg"
  sudo -u openclaw XDG_RUNTIME_DIR="/run/user/$OC_UID" \
    openclaw message send --channel "$NOTIFY_CHANNEL" --target "$NOTIFY_TARGET" \
    --message "$msg" 2>&1 | tail -3 || echo "[sync] (alert send failed — gateway may be down)"
}

# Best-effort recovery: if a cutover failure left the gateway down, restart it
# so a broken deploy never leaves the live service offline. No-op before cutover
# (the gateway was never stopped) or if it is already listening.
restore_gateway_if_down() {
  [ "$GATEWAY_TOUCHED" -eq 1 ] || return 0
  ss -ltnp 2>/dev/null | grep -q 18789 && return 0
  echo "[sync] gateway down after failure — attempting restart"
  $OC_SYSTEMCTL restart openclaw-gateway.service 2>&1 | tail -3 || true
  for _ in $(seq 1 12); do
    ss -ltnp 2>/dev/null | grep -q 18789 && break
    sleep 5
  done
}

# Fire on any non-zero exit. flock-skip above exits 0 (no alert). Restore the
# gateway first so the service is back before the alert (which itself goes
# through the gateway).
on_exit() {
  local rc=$?
  # Always undo the temporary workspace->file: dependency rewrite so a failed
  # deploy never leaves the committed package.json mutated on disk (idempotent).
  node "$REPO_DIR/scripts/prepare-global-install-package-json.mjs" --restore 2>/dev/null || true
  [ "$rc" -ne 0 ] || return 0
  restore_gateway_if_down
  notify_failure "$rc"
}
trap on_exit EXIT

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
# The gateway stays up (old version) through install + bundle + migrations so a
# failure here never takes the live service down — only the cutover restart at
# the end swaps versions. The running node process holds its loaded modules in
# memory (open inodes), so overwriting dist on disk does not disturb it.
step "2/2  Deploy (host — step 8)"

# Clear stale npm temp symlinks that block the atomic rename during install.
sudo rm -f "$(npm root -g)"/.openclaw-* 2>/dev/null || true

# Install from local repo globally — --install-links forces a real copy
# (without it npm 7+ creates a symlink, which breaks cross-user access).
#
# Upstream ships internal packages (e.g. @openclaw/ai) as `workspace:*` runtime
# deps of the root package. npm rejects that protocol; this fork installs from
# source, not the npm registry, so rewrite those to absolute `file:` paths for
# the install, then restore the committed `workspace:*` form immediately after.
STAGE="deploy: npm i -g (gateway still up)"
node scripts/prepare-global-install-package-json.mjs
sudo npm i -g . --install-links
node scripts/prepare-global-install-package-json.mjs --restore

# Copy externalized extensions, reinstall supergateway, rebuild Control UI.
# CI=true keeps pnpm non-interactive: the Control UI rebuild (scripts/ui.js)
# may run `pnpm install`, which can hit pnpm's "remove modules and reinstall
# from scratch? (Y/n)" purge prompt. Under cron (no TTY) that would hang/fail;
# CI mode makes pnpm auto-proceed.
STAGE="deploy: pnpm deploy:globally (gateway still up)"
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

# Pin the Codex app-server binary. The fork bundles the codex plugin, so its
# app-server code ends up in a dist-root chunk; the managed-binary resolver then
# derives the wrong plugin root and misses the bundled @openai/codex binary,
# failing every openai model (routed through Codex) with "app-server binary was
# not found". Point the gateway at the deployed binary explicitly (the supported
# OPENCLAW_CODEX_APP_SERVER_BIN override). Idempotent: update in place or append.
UNIT_FILE=/home/openclaw/.config/systemd/user/openclaw-gateway.service
CODEX_BIN="$(npm root -g)/openclaw/dist/extensions/codex/node_modules/.bin/codex"
if grep -q OPENCLAW_CODEX_APP_SERVER_BIN "$UNIT_FILE"; then
  sudo -u openclaw sed -i \
    "s#Environment=OPENCLAW_CODEX_APP_SERVER_BIN=.*#Environment=OPENCLAW_CODEX_APP_SERVER_BIN=$CODEX_BIN#" \
    "$UNIT_FILE"
else
  sudo -u openclaw sed -i \
    "/Environment=OPENCLAW_SERVICE_VERSION=/a Environment=OPENCLAW_CODEX_APP_SERVER_BIN=$CODEX_BIN" \
    "$UNIT_FILE"
fi
$OC_SYSTEMCTL daemon-reload

# Run doctor first so its safe migrations land before the preflight judges the
# config. --non-interactive applies safe migrations only and never prompts (a
# destructive config change would otherwise block here waiting for
# confirmation). Best-effort: doctor reports some invalid configs without
# repairing them, so the gate below — not doctor's exit code — is the authority.
sudo -u openclaw XDG_RUNTIME_DIR=/run/user/$OC_UID openclaw doctor --fix --non-interactive 2>&1 || true

# Config preflight — the last gate before the gateway is stopped.
#
# The new build validates config at startup and exits 78/CONFIG when it fails,
# so cutting over with an invalid config kills a working gateway and leaves it
# down. This is a real upgrade hazard, not a hypothetical: a key core still
# writes and reads can be rejected by a newer channel plugin's manifest schema
# (openclaw/openclaw#117965), and `doctor --fix` reports that case without
# repairing it.
#
# Fail here, while the old gateway is still serving. GATEWAY_TOUCHED is still 0,
# so the EXIT trap skips restore_gateway_if_down, and the failure alert can
# still route through the live gateway — a post-cutover failure cannot alert,
# because the gateway it sends through is the one that is down.
STAGE="deploy: config preflight (gateway still up)"
if ! sudo -u openclaw XDG_RUNTIME_DIR=/run/user/$OC_UID openclaw config validate 2>&1; then
  echo ""
  echo "  ✗ Config is invalid for the newly installed build — skipping cutover."
  echo "    The gateway keeps running the previous version and stays up."
  echo ""
  echo "    NOTE: the running process is the only thing still serving. The new"
  echo "    dist is already installed, so a restart, crash, or reboot starts the"
  echo "    new build and fails with 78/CONFIG. Treat this as urgent."
  echo ""
  echo "    The doctor run above may itself have migrated the config into the"
  echo "    invalid shape; compare against its backup before hand-editing:"
  echo "      ls -t /home/openclaw/.openclaw/openclaw.json*.bak | head -1"
  echo ""
  echo "    Then repair, confirm, and restart:"
  echo "      sudo -u openclaw openclaw config validate"
  echo "      systemctl --user restart openclaw-gateway.service"
  exit 1
fi

# ── Cutover ────────────────────────────────────────────────────────────────
# Everything above kept the old gateway serving. From here we swap to the new
# version. A failure now means the new build is genuinely broken; the EXIT trap
# still attempts to bring a gateway back (restore_gateway_if_down).
STAGE="deploy: cutover (gateway restart)"
GATEWAY_TOUCHED=1

# Remove stale sandbox containers so they respawn with new mounts/env vars.
docker rm -f \
  $(docker ps -a --filter "name=openclaw-sbx" --format "{{.Names}}" 2>/dev/null) \
  2>/dev/null || true

$OC_SYSTEMCTL restart openclaw-gateway.service

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
