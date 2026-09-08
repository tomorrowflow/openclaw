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

# --deploy-only runs stage 2 alone. The sync stage is a separate concern: when a
# release bump is too large for the agent's single iteration it gets rebased by
# hand, and the deploy still needs the tested path rather than hand-run steps.
RUN_SYNC=1
case "${1:-}" in
  --deploy-only) RUN_SYNC=0 ;;
  "") ;;
  *) echo "usage: $(basename "$0") [--deploy-only]" >&2; exit 2 ;;
esac

# Where failure alerts go. openclaw runs as the openclaw user, so the send is
# wrapped in `sudo -u openclaw`. Signal target is an E.164 number.
NOTIFY_CHANNEL="signal"
NOTIFY_TARGET="+491755252288"

# Direct signal-cli fallback for the case the gateway cannot deliver the alert.
# NOTIFY_SENDER is the registered signal-cli account (E.164) that owns the store.
SIGNAL_CLI="/home/openclaw/bin/signal-cli"
NOTIFY_SENDER="+493055464974"

# Gateway listen port, used by every readiness/liveness probe below.
GATEWAY_PORT=18789

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

# Run an openclaw CLI command as the service user from a neutral directory.
# This script works from $REPO_DIR under /home/frogger, which is mode 750 and
# not traversable by openclaw. A child process spawned with an unreadable cwd
# fails EACCES, so `openclaw doctor` reported "systemctl is-enabled unavailable"
# and left the service verdict "unknown" — which is exactly what made it refuse
# maintenance during cutover, leaving schema migrations unapplied.
oc_openclaw() {
  (cd /tmp && sudo -u openclaw XDG_RUNTIME_DIR="/run/user/$OC_UID" openclaw "$@")
}

# Tracks the current phase so the failure alert can say where it broke.
STAGE="startup"

# Set to 1 only once the deploy reaches the cutover (gateway restart). Until
# then the gateway is never stopped, so a pre-cutover failure leaves it running
# and needs no restore. After cutover the EXIT trap uses this to bring it back.
GATEWAY_TOUCHED=0

# Send an alert as the openclaw user.
#
# The gateway is the canonical send path, but it is also the thing most likely
# to be broken when this fires: a failed cutover leaves it down, and the alert
# then dies with it. That is exactly how the 2026-08-24 outage went unreported
# for three days — the deploy detected "gateway not listening", tried to alert
# through the gateway, and lost the message.
#
# So fall back to signal-cli directly. Normally that is forbidden (the gateway
# owns the signal-cli daemon, and the daemon holds an exclusive lock on the
# account store — a direct send would hang). Here the precondition is inverted
# and checked: we only take this path when nothing is listening on the gateway
# port, which means the daemon that would hold the lock is not running either.
notify_send() {
  local msg="$1"
  echo "$msg"
  if sudo -u openclaw XDG_RUNTIME_DIR="/run/user/$OC_UID" \
    openclaw message send --channel "$NOTIFY_CHANNEL" --target "$NOTIFY_TARGET" \
    --message "$msg" 2>&1 | tail -3; then
    return 0
  fi
  if ss -ltn 2>/dev/null | grep -q ":${GATEWAY_PORT}\b"; then
    echo "[sync] (alert send failed while the gateway is up — not risking the signal-cli account lock)"
    return 1
  fi
  echo "[sync] gateway is down — sending the alert through signal-cli directly"
  if sudo -u openclaw "$SIGNAL_CLI" -a "$NOTIFY_SENDER" send -m "$msg" "$NOTIFY_TARGET" 2>&1 | tail -3; then
    return 0
  fi
  echo "[sync] (direct signal-cli send failed too — this run is only recorded in $LOG_FILE)"
  return 1
}

notify_failure() {
  local rc="$1"
  notify_send "⚠ OpenClaw sync FAILED on $(hostname) — stage: ${STAGE} (exit ${rc}). Log: ${LOG_FILE}" || true
}

# Best-effort recovery: if a cutover failure left the gateway down, restart it
# so a broken deploy never leaves the live service offline. No-op before cutover
# (the gateway was never stopped) or if it is already listening.
restore_gateway_if_down() {
  [ "$GATEWAY_TOUCHED" -eq 1 ] || return 0
  ss -ltnp 2>/dev/null | grep -q ":${GATEWAY_PORT}\b" && return 0
  echo "[sync] gateway down after failure — attempting restart"
  $OC_SYSTEMCTL restart openclaw-gateway.service 2>&1 | tail -3 || true
  for _ in $(seq 1 12); do
    ss -ltnp 2>/dev/null | grep -q ":${GATEWAY_PORT}\b" && break
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
if [ "$RUN_SYNC" -eq 1 ]; then
  STAGE="sync (Codex agent, steps 1–7)"
  step "1/2  Sync (Codex agent — steps 1–7)"
  npx tsx .sandcastle/sync.ts
else
  step "1/2  Sync — skipped (--deploy-only)"
  echo "  Deploying the working tree as-is: $(git -C "$REPO_DIR" rev-parse --short HEAD)"
fi

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
UNIT_FILE=/home/openclaw/.config/systemd/user/openclaw-gateway.service
NEW_VER=$(node -p "require('$(npm root -g)/openclaw/package.json').version")

# Set an Environment= line whether or not it is already present. `openclaw
# gateway install --force` regenerates the unit from the stock template and
# drops every fork-added Environment line, so a substitute-only edit silently
# restores nothing and the settings below stay missing until someone notices.
set_unit_env() {
  local key="$1" value="$2"
  if sudo grep -q "^Environment=$key=" "$UNIT_FILE"; then
    sudo -u openclaw sed -i "s#^Environment=$key=.*#Environment=$key=$value#" "$UNIT_FILE"
  else
    sudo -u openclaw sed -i "/^\[Service\]/a Environment=$key=$value" "$UNIT_FILE"
  fi
}

set_unit_env OPENCLAW_SERVICE_VERSION "$NEW_VER"
sudo -u openclaw sed -i \
  "s/Description=OpenClaw Gateway.*/Description=OpenClaw Gateway (v$NEW_VER)/" \
  "$UNIT_FILE"

# Pin the Codex app-server binary. The fork bundles the codex plugin, so its
# app-server code ends up in a dist-root chunk; the managed-binary resolver then
# derives the wrong plugin root and misses the bundled @openai/codex binary,
# failing every openai model (routed through Codex) with "app-server binary was
# not found". Point the gateway at the deployed binary explicitly (the supported
# OPENCLAW_CODEX_APP_SERVER_BIN override). Idempotent: update in place or append.
CODEX_BIN="$(npm root -g)/openclaw/dist/extensions/codex/node_modules/.bin/codex"
set_unit_env OPENCLAW_CODEX_APP_SERVER_BIN "$CODEX_BIN"
$OC_SYSTEMCTL daemon-reload

# Run doctor first so its safe migrations land before the preflight judges the
# config. --non-interactive applies safe migrations only and never prompts (a
# destructive config change would otherwise block here waiting for
# confirmation). Best-effort: doctor reports some invalid configs without
# repairing them, so the gate below — not doctor's exit code — is the authority.
oc_openclaw doctor --fix --non-interactive 2>&1 || true

# Config invariants — settings whose loss is silent.
#
# `config validate` below only proves the config is well-formed for the new
# build; it cannot know which values this host depends on. Every key asserted
# here fails invisibly when it drifts: the gateway starts, the channel reports
# healthy, and voice replies simply stop. The doctor run above is itself allowed
# to rewrite config, so this runs after it, not before.
STAGE="deploy: config invariants (gateway still up)"
CFG_SNAPSHOT="$(mktemp)"
sudo cat /home/openclaw/.openclaw/openclaw.json > "$CFG_SNAPSHOT"
python3 - "$CFG_SNAPSHOT" <<'PY'
import json, sys

cfg = json.load(open(sys.argv[1]))
bad = []

def get(path):
    node = cfg
    for key in path.split("."):
        if not isinstance(node, dict):
            return None
        node = node.get(key)
    return node

def want(path, expected):
    actual = get(path)
    if actual != expected:
        bad.append(f"{path}: expected {expected!r}, got {actual!r}")

# The Codex harness declares deliveryDefaults.visibleReplies="message_tool"
# (extensions/codex/harness.ts). That routes replies through the message tool,
# which sends directly and never produces the payload the gateway TTS stage
# speaks. Only an explicit config value outranks the harness default.
want("messages.visibleReplies", "automatic")

# `localhost` resolves to ::1 first on this host, and the IPv6 docker-proxy
# forward to both speech containers resets on connect. The IPv4 literals are
# load-bearing; without them TTS and transcription fail closed.
want("tts.providers.kokoro.url", "http://127.0.0.1:9007")

models = get("tools.media.models") or []
asr = models[0] if models else {}
if asr.get("baseUrl") != "http://127.0.0.1:9009":
    bad.append(f"tools.media.models[0].baseUrl: expected 'http://127.0.0.1:9009', got {asr.get('baseUrl')!r}")

# cliPath is a retired top-level key; it lives under transport now. Losing it
# leaves signal-cli unresolvable.
want("channels.signal.transport.cliPath", "/home/openclaw/bin/signal-cli")

# The agent's own tts tool synthesizes audio outside the gateway pipeline and
# strands it on disk. Speech is the gateway's job.
if "tts" not in (get("tools.deny") or []):
    bad.append('tools.deny: must contain "tts"')

if bad:
    print("  ✗ config invariants drifted — skipping cutover:")
    for item in bad:
        print(f"    - {item}")
    sys.exit(1)
print("  ✓ config invariants intact")
PY
rm -f "$CFG_SNAPSHOT"

# Plugin contract — core/plugin drift that config validation cannot see.
#
# Core requires the inbound-debounce `admission` contract; a signal plugin that
# predates it throws "Cannot read properties of undefined (reading 'catch')" on
# every inbound message. The gateway still starts and still listens, so nothing
# downstream catches it — the channel is simply dead. Assert the contract is
# present in the plugin build this deploy will actually load.
#
# This gate has now broken twice by binding to the state DB's internal shape:
# first when the records moved from `install_records_json` to `plugins_json`,
# then when `installed_plugin_index` was dropped altogether. Both times the
# query returned nothing and the gate stopped checking — the exact failure mode
# it exists to catch. The registry, not the database, owns "which plugin will
# load", so ask the freshly installed build directly: `plugins list` enumerates
# the installed dist, and its `--json` output is a stable CLI contract.
STAGE="deploy: plugin contract (gateway still up)"

# Emits exactly one of `ok:<rootDir>`, `missing`, or `error:<reason>` so a probe
# that cannot answer fails the gate instead of reading as "no plugin".
SIGNAL_PLUGIN_PROBE="$(oc_openclaw plugins list --json 2>/dev/null | python3 -c '
import json, sys

try:
    plugins = json.load(sys.stdin).get("plugins") or []
except Exception as exc:
    print(f"error:cannot read the plugin registry ({exc})")
    sys.exit(0)

record = next((p for p in plugins if p.get("id") == "signal"), None)
if record is None:
    print("missing")
else:
    root = record.get("rootDir") or ""
    print("ok:" + root if root else "error:signal plugin record carries no rootDir")
' || echo "error:plugins list probe failed")"

SIGNAL_CONFIGURED="$(sudo python3 -c "
import json
cfg = json.load(open('/home/openclaw/.openclaw/openclaw.json'))
print('yes' if (cfg.get('channels') or {}).get('signal') else 'no')
" 2>/dev/null || echo unknown)"

case "$SIGNAL_PLUGIN_PROBE" in
  ok:*)
    SIGNAL_PLUGIN_DIR="${SIGNAL_PLUGIN_PROBE#ok:}"
    if ! sudo grep -rqs "admission" "$SIGNAL_PLUGIN_DIR"; then
      echo ""
      echo "  ✗ Active signal plugin does not implement the inbound 'admission'"
      echo "    contract — every inbound message would fail silently."
      echo "    Plugin: $SIGNAL_PLUGIN_DIR"
      echo "    Upgrade it before cutover; note that installing over a retired"
      echo "    config key aborts before the install record is written, so remove"
      echo "    channels.signal, update, then restore it in the new shape."
      echo ""
      exit 1
    fi
    echo "  ✓ signal plugin implements the inbound admission contract"
    ;;
  missing)
    if [ "$SIGNAL_CONFIGURED" = "no" ]; then
      echo "  · signal channel not configured — contract check not applicable"
    else
      echo ""
      echo "  ✗ channels.signal is configured but the installed build resolves no"
      echo "    signal plugin — the channel would be dead after cutover."
      echo "    Inspect: sudo -u openclaw openclaw plugins list"
      echo ""
      exit 1
    fi
    ;;
  *)
    # A probe that cannot answer is not evidence of a healthy plugin.
    echo ""
    echo "  ✗ Could not determine which signal plugin this deploy would load."
    echo "    ${SIGNAL_PLUGIN_PROBE#error:}"
    echo "    Inspect: sudo -u openclaw openclaw plugins list --json"
    echo ""
    exit 1
    ;;
esac

# Managed ingress preflight.
#
# When gateway.tailscale.mode is serve/funnel, the gateway claims a Tailscale
# route during startup and treats any failure there as fatal — it is the
# Gateway's own ingress, so it fails closed rather than starting degraded.
# `config validate` cannot see this: the config is perfectly valid, the tailnet
# is simply not usable.
#
# That is the 2026-08-24 outage exactly. The node key had expired three days
# earlier; nothing noticed because the old gateway was already running and only
# claims the route at startup. The cutover restarted it, `tailscale serve`
# returned "Logged out.", and the service crash-looped for three days.
#
# So check the tailnet the same way the gateway will, while the old gateway is
# still serving. BackendState must be "Running" — "NeedsLogin"/"Stopped" mean
# the cutover would restart into a gateway that cannot start.
STAGE="deploy: managed ingress preflight (gateway still up)"
TS_MODE=$(sudo python3 -c "
import json
cfg = json.load(open('/home/openclaw/.openclaw/openclaw.json'))
print(((cfg.get('gateway') or {}).get('tailscale') or {}).get('mode') or 'off')
" 2>/dev/null || echo off)
if [ "$TS_MODE" != "off" ]; then
  TS_STATE=$(tailscale status --json 2>/dev/null \
    | python3 -c "import json,sys; print(json.load(sys.stdin).get('BackendState') or 'unknown')" \
    2>/dev/null || echo unknown)
  if [ "$TS_STATE" != "Running" ]; then
    echo ""
    echo "  ✗ gateway.tailscale.mode=$TS_MODE but the tailnet is not usable"
    echo "    (BackendState: $TS_STATE) — skipping cutover."
    echo "    The gateway keeps running the previous version and stays up."
    echo ""
    echo "    The new build would claim a Tailscale route at startup, fail, and"
    echo "    crash-loop. Re-authenticate, confirm, then deploy again:"
    echo "      sudo tailscale up"
    echo "      tailscale status"
    echo ""
    echo "    A node key expires every ~6 months. Disable key expiry for this"
    echo "    machine in the Tailscale admin console to stop this recurring."
    exit 1
  fi
  echo "  ✓ tailnet is up (mode: $TS_MODE, BackendState: $TS_STATE)"
fi

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
if ! oc_openclaw config validate 2>&1; then
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

# Stop, migrate, start — deliberately not `restart`. Agent database schema
# migrations need exclusive access to the files, so the doctor run above (taken
# while the gateway was still serving) reports them pending and repairs nothing.
# A plain restart then comes up on the old schema and keeps failing silently:
# that is how the agent databases sat on schema 17 while every outbound delivery
# failed to mirror into its session transcript. This stopped window is the only
# point in the deploy where the migration can actually run.
$OC_SYSTEMCTL stop openclaw-gateway.service
for _ in $(seq 1 15); do
  ss -ltn 2>/dev/null | grep -q ":${GATEWAY_PORT}\b" || break
  sleep 2
done

STAGE="deploy: cutover (agent database migration)"
echo "  Migrating agent databases while the gateway is stopped..."
oc_openclaw doctor --fix --non-interactive 2>&1 | tail -5 || true

STAGE="deploy: cutover (gateway start)"
$OC_SYSTEMCTL start openclaw-gateway.service

# Poll up to 60 s for the gateway to start listening.
echo "  Waiting for gateway on :${GATEWAY_PORT}..."
for i in $(seq 1 12); do
  ss -ltnp | grep -q ":${GATEWAY_PORT}\b" && break
  sleep 5
done

if ss -ltnp | grep -q ":${GATEWAY_PORT}\b"; then
  echo "  ✓ Gateway listening on :${GATEWAY_PORT}"
else
  echo "  ✗ Gateway not listening after 60s — check logs:"
  sudo -u openclaw XDG_RUNTIME_DIR=/run/user/$OC_UID \
    journalctl --user -u openclaw-gateway.service -n 40 --no-pager
  STAGE="deploy: gateway not listening after restart"
  exit 1
fi

# ── Post-cutover smoke ─────────────────────────────────────────────────────
# A listening port only proves the process is alive. On 2026-08-09 the gateway
# listened for nine hours while every inbound Signal message died in the drain
# and the DM lane stayed head-of-line blocked — nothing here noticed. These two
# checks are deliberately generic: they detect any inbound path that fails
# repeatedly, not just the contract break that motivated them.
#
# Advisory by design. The new build is already live and healthy enough to serve;
# aborting now would not undo the cutover. Alert and let the operator decide.
STAGE="deploy: post-cutover smoke"
echo ""
echo "  Post-cutover smoke (settling 45s)..."
sleep 45

SMOKE_PROBLEMS=""

# 1. Crash signatures. Both indicate a turn that ended with nothing delivered.
CRASH_HITS=$(sudo -u openclaw XDG_RUNTIME_DIR=/run/user/$OC_UID \
  journalctl --user -u openclaw-gateway.service --since "-3 min" --no-pager 2>/dev/null \
  | grep -cE "reading 'catch'|no queued reply payloads" || true)
if [ "${CRASH_HITS:-0}" -gt 0 ]; then
  SMOKE_PROBLEMS="${SMOKE_PROBLEMS}\n  - ${CRASH_HITS} inbound crash/zero-payload log line(s) since restart"
fi

# 2. Stuck ingress. Retries are normal; a retry that keeps failing is not. This
#    is the signal that reached nobody today: rows pile up pending with an error
#    while the channel reports healthy.
STUCK=$(sudo python3 -c "
import sqlite3
db = 'file:/home/openclaw/.openclaw/state/openclaw.sqlite?mode=ro'
try:
    print(sqlite3.connect(db, uri=True).execute(
        \"select count(*) from channel_ingress_events \"
        \"where status='pending' and last_error is not null\").fetchone()[0])
except Exception:
    print(0)
" 2>/dev/null || echo 0)
if [ "${STUCK:-0}" -gt 0 ]; then
  SMOKE_PROBLEMS="${SMOKE_PROBLEMS}\n  - ${STUCK} inbound event(s) stuck pending with an error"
fi

# 3. Schema agreement. The migration above runs in the stopped window, but a
#    doctor that reports without repairing leaves the databases behind the build.
#    That failure is silent at runtime — the gateway serves normally and only
#    transcript mirroring dies — so compare the declared schema against disk.
WANT_AGENT_SCHEMA=$(python3 -c "import json; print(json.load(open('$REPO_DIR/package.json'))['openclaw']['schemaVersions']['agent'])" 2>/dev/null || echo "")
if [ -n "$WANT_AGENT_SCHEMA" ]; then
  BEHIND=$(sudo python3 -c "
import glob, sqlite3, sys
want = int(sys.argv[1])
behind = []
for path in sorted(glob.glob('/home/openclaw/.openclaw/agents/*/agent/openclaw-agent.sqlite')):
    try:
        con = sqlite3.connect(f'file:{path}?mode=ro', uri=True)
        row = con.execute(\"select schema_version from schema_meta where meta_key='primary'\").fetchone()
        if row and int(row[0]) < want:
            behind.append(path.split('/agents/')[1].split('/')[0])
    except Exception:
        pass
print(','.join(behind))
" "$WANT_AGENT_SCHEMA" 2>/dev/null || echo "")
  if [ -n "$BEHIND" ]; then
    SMOKE_PROBLEMS="${SMOKE_PROBLEMS}\n  - agent database(s) still below schema ${WANT_AGENT_SCHEMA}: ${BEHIND}"
  fi
fi

if [ -n "$SMOKE_PROBLEMS" ]; then
  echo ""
  echo "  ⚠ Gateway is up but inbound processing looks unhealthy:"
  printf "%b\n" "$SMOKE_PROBLEMS"
  echo "    Channel may be silently dead — check before relying on it."
  sudo -u openclaw XDG_RUNTIME_DIR="/run/user/$OC_UID" \
    openclaw message send --channel "$NOTIFY_CHANNEL" --target "$NOTIFY_TARGET" \
    --message "⚠ OpenClaw deploy v$NEW_VER: gateway is up but inbound processing looks unhealthy.$(printf "%b" "$SMOKE_PROBLEMS")
Log: $LOG_FILE" 2>&1 | tail -3 || echo "  (smoke alert send failed — inbound may be down both ways)"
else
  echo "  ✓ No inbound crash signatures or stuck ingress events"
fi

echo ""
echo "✓ Sync and deploy complete (v$NEW_VER)  —  $(date)"
echo "  Log: $LOG_FILE"
