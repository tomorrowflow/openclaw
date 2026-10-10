#!/usr/bin/env bash
# Keep factory node satellites on the Gateway host's deployed OpenClaw build.
#
#   deploy-satellites.sh prepare-source  build the checked-out commit on source satellites
#   deploy-satellites.sh prepare         stage the installed build next to each running node
#   deploy-satellites.sh activate        switch each node to the staged build and restart it
#
# sync-and-deploy.sh starts `prepare-source` in the background before its own
# build (source satellites only need the commit), `prepare` once the new build
# is installed (the Gateway still serves the old one), and `activate` only
# after the cutover smoke passed, so a failed deploy never moves a satellite
# ahead of its Gateway. Satellites run in parallel within each phase. Failures
# are per satellite and never fail the Gateway deploy: the script reports them
# and exits 1, and the caller turns that into a warning.
#
# Satellites are listed one per line in $OPENCLAW_SATELLITES_FILE
# (default ~/.config/openclaw-deploy/satellites.conf), so adding a node needs no
# commit:
#
#   <node name> <kind> <target>
#   linux-factory-minisforum790   local-systemd  factory
#   linux-factory-minisforum3090  linux-tarball  frogger@minisforum3090
#
# Kinds:
#   local-systemd  a node on this host running the global CLI as <target> user;
#                  `activate` restarts it (prepare has nothing to stage).
#   linux-tarball  a Linux node reached over SSH (key auth, passwordless sudo)
#                  whose node user `factory` runs a CLI unpacked into
#                  ~/.local/lib/openclaw from a packed copy of the global install.
#   macos-source   a macOS node reached over SSH as its node user (<target> is
#                  factory@host). Its native addons differ, so it builds the same
#                  commit from a fork checkout in ~/factory/openclaw-src into
#                  ~/.local/openclaw (npm --prefix); its LaunchDaemon wrapper puts
#                  ~/.local/bin first on PATH. KeepAlive restarts the node.
set -euo pipefail

PHASE="${1:-}"
SATELLITES_FILE="${OPENCLAW_SATELLITES_FILE:-$HOME/.config/openclaw-deploy/satellites.conf}"
LOG_DIR="${OPENCLAW_SATELLITES_LOG_DIR:-$HOME/logs/satellites}"
NODE_USER=factory
GLOBAL_ROOT="$(npm root -g)/openclaw"
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=10)

[[ "$PHASE" == prepare-source || "$PHASE" == prepare || "$PHASE" == activate ]] || {
  echo "usage: $(basename "$0") prepare-source|prepare|activate" >&2
  exit 2
}
if [[ ! -f "$SATELLITES_FILE" ]]; then
  echo "[satellites] no $SATELLITES_FILE; nothing to do"
  exit 0
fi
mkdir -p "$LOG_DIR"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FORK_REMOTE_URL="$(git -C "$REPO_DIR" remote get-url origin)"
# The build identity every satellite must end up on: the commit about to be
# built for prepare-source, otherwise the installed CLI's short sha.
if [[ "$PHASE" == prepare-source ]]; then
  SHA=$(git -C "$REPO_DIR" rev-parse HEAD)
else
  SHA=$(cd /tmp && "$GLOBAL_ROOT/openclaw.mjs" --version | grep -o '([0-9a-f]*)' | tr -d '()')
fi
[[ -n "$SHA" ]] || { echo "[satellites] cannot read the build sha" >&2; exit 1; }
TARBALL="$HOME/openclaw-cli-$SHA.tar.zst"

# as_node_user <target> <script>: run a bash script as the node user, locally
# or on <user@host>, with its systemd user bus.
as_node_user() {
  local target="$1" script="$2"
  local wrapped="U=\$(id -u $NODE_USER); sudo -u $NODE_USER env XDG_RUNTIME_DIR=/run/user/\$U DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/\$U/bus bash -lc $(printf '%q' "$script")"
  if [[ "$target" == *@* ]]; then
    "${SSH[@]}" "$target" "$wrapped"
  else
    bash -c "$wrapped"
  fi
}

# as_mac <target> <script>: run a bash script as the macOS node user over SSH,
# with the PATH its LaunchDaemon wrapper uses.
as_mac() {
  "${SSH[@]}" "$1" bash -s <<<"set -euo pipefail
export PATH=\$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0
$2"
}

prepare-source_one() {
  local name="$1" kind="$2" target="$3"
  [[ "$kind" == macos-source ]] || { echo "nothing to build ($kind)"; return 0; }
  # Staged beside the running install; the node keeps its files until activate.
  as_mac "$target" "
    SRC=\$HOME/factory/openclaw-src
    [ -d \$SRC/.git ] || git clone --quiet $FORK_REMOTE_URL \$SRC
    cd \$SRC
    git fetch --quiet origin
    git checkout --quiet --force --detach $SHA
    corepack pnpm install --frozen-lockfile --reporter=silent
    corepack pnpm build >/dev/null
    node scripts/prepare-global-install-package-json.mjs
    trap 'node scripts/prepare-global-install-package-json.mjs --restore' EXIT
    rm -rf \$HOME/.local/openclaw.next
    npm i -g . --install-links --prefix \$HOME/.local/openclaw.next --silent
    echo $SHA > \$HOME/.local/openclaw.next/lib/node_modules/openclaw/.satellite-sha"
  echo "built ${SHA:0:12} on ${target#*@}"
}

pack_tarball() {
  [[ -f "$TARBALL" ]] && return 0
  tar -I 'zstd -T0 -3' -cf "$TARBALL.partial" -C "$(dirname "$GLOBAL_ROOT")" openclaw
  mv "$TARBALL.partial" "$TARBALL"
  find "$HOME" -maxdepth 1 -name 'openclaw-cli-*.tar.zst' ! -name "openclaw-cli-$SHA.tar.zst" -delete
}

prepare_one() {
  local name="$1" kind="$2" target="$3"
  case "$kind" in
    local-systemd) echo "nothing to stage (global CLI)" ;;
    macos-source) echo "staged by prepare-source" ;;
    linux-tarball)
      scp -q -o BatchMode=yes -o ConnectTimeout=10 "$TARBALL" "$target:/tmp/openclaw-cli-$SHA.tar.zst"
      "${SSH[@]}" "$target" "sudo chown $NODE_USER: /tmp/openclaw-cli-$SHA.tar.zst"
      # Staged beside the running CLI; the running node keeps its files until activate.
      as_node_user "$target" "
        set -euo pipefail
        cd ~/.local/lib
        rm -rf openclaw.next openclaw.next.tmp && mkdir openclaw.next.tmp
        tar -I zstd -xf /tmp/openclaw-cli-$SHA.tar.zst -C openclaw.next.tmp
        rm -f /tmp/openclaw-cli-$SHA.tar.zst
        mv openclaw.next.tmp/openclaw openclaw.next && rmdir openclaw.next.tmp
        echo $SHA > openclaw.next/.satellite-sha"
      echo "staged $SHA on ${target#*@}"
      ;;
    *) echo "unknown kind $kind" >&2; return 1 ;;
  esac
}

# The node must come back on the new build: service active and CLI reporting SHA.
check_node() {
  local target="$1"
  as_node_user "$target" "
    sleep 3
    systemctl --user is-active --quiet openclaw-node
    openclaw --version | grep -q '($SHA)'"
}

# The macOS node has no unit to query; its KeepAlive brings the process back.
check_mac_node() {
  as_mac "$1" "
    sleep 5
    pgrep -f 'openclaw node run' >/dev/null
    openclaw --version | grep -q '($SHA)'"
}

activate_one() {
  local name="$1" kind="$2" target="$3"
  case "$kind" in
    macos-source)
      as_mac "$target" "
        cd \$HOME/.local
        staged=\$(cat openclaw.next/lib/node_modules/openclaw/.satellite-sha 2>/dev/null || true)
        live=\$(cat openclaw/lib/node_modules/openclaw/.satellite-sha 2>/dev/null || true)
        if [ ! -d openclaw.next ] && [ \"\${live#$SHA}\" != \"\$live\" ]; then
          : already on $SHA
        elif [ -n \"\$staged\" ] && [ \"\${staged#$SHA}\" != \"\$staged\" ]; then
          rm -rf openclaw.old
          if [ -d openclaw ]; then mv openclaw openclaw.old; fi
          mv openclaw.next openclaw
          mkdir -p bin
          ln -sfn ../openclaw/lib/node_modules/openclaw/openclaw.mjs bin/openclaw
        else
          echo 'no staged $SHA build' >&2
          false
        fi
        pkill -f 'openclaw node run' || true"
      if check_mac_node "$target"; then
        as_mac "$target" "rm -rf \$HOME/.local/openclaw.old"
      else
        echo "new build did not come up; rolling back" >&2
        as_mac "$target" "
          cd \$HOME/.local
          if [ -d openclaw.old ]; then rm -rf openclaw && mv openclaw.old openclaw; fi
          pkill -f 'openclaw node run' || true" || true
        return 1
      fi
      ;;
    local-systemd)
      as_node_user "$target" "systemctl --user restart openclaw-node"
      check_node "$target"
      ;;
    linux-tarball)
      # No `exit` in these scripts: a login shell's exit builtin runs
      # ~/.bash_logout, whose clear_console fails without a terminal.
      as_node_user "$target" "
        set -euo pipefail
        cd ~/.local/lib
        if [ -f openclaw/.satellite-sha ] && [ \"\$(cat openclaw/.satellite-sha)\" = $SHA ] && [ ! -d openclaw.next ]; then
          : already on $SHA
        elif [ \"\$(cat openclaw.next/.satellite-sha 2>/dev/null)\" = $SHA ]; then
          rm -rf openclaw.old
          if [ -d openclaw ]; then mv openclaw openclaw.old; fi
          mv openclaw.next openclaw
          ln -sfn ../lib/openclaw/openclaw.mjs ~/.local/bin/openclaw
        else
          echo 'no staged $SHA build' >&2
          false
        fi
        # A failed restart is judged by check_node below, which rolls back.
        systemctl --user restart openclaw-node || true"
      if check_node "$target"; then
        as_node_user "$target" "rm -rf ~/.local/lib/openclaw.old"
      else
        echo "new build did not come up; rolling back" >&2
        as_node_user "$target" "
          cd ~/.local/lib
          if [ -d openclaw.old ]; then rm -rf openclaw && mv openclaw.old openclaw; fi
          systemctl --user restart openclaw-node" || true
        return 1
      fi
      ;;
    *) echo "unknown kind $kind" >&2; return 1 ;;
  esac
  # Gateway view: the reconnected node still offers ticket runs.
  local described=""
  for _ in 1 2 3 4 5 6; do
    described=$(cd /tmp && sudo -n -u openclaw openclaw nodes describe --node "$name" 2>&1 || true)
    grep -q 'agent.cli.claude.run.v1' <<<"$described" && return 0
    sleep 5
  done
  echo "Gateway does not see agent.cli.claude.run.v1 on $name" >&2
  return 1
}

if [[ "$PHASE" == prepare ]] && grep -qE '^[^#[:space:]]+[[:space:]]+linux-tarball' "$SATELLITES_FILE"; then
  pack_tarball
fi

declare -A PIDS=()
while read -r name kind target _; do
  [[ -z "${name:-}" || "$name" == \#* ]] && continue
  log="$LOG_DIR/$name.$PHASE.log"
  # </dev/null: ssh would otherwise read the rest of the satellites file.
  ( set -euo pipefail; echo "== $PHASE $name ($kind $target) → $SHA  $(date)"; "${PHASE}_one" "$name" "$kind" "$target" ) </dev/null >"$log" 2>&1 &
  PIDS[$name]=$!
done <"$SATELLITES_FILE"

FAILED=()
for name in "${!PIDS[@]}"; do
  if wait "${PIDS[$name]}"; then
    echo "[satellites] $PHASE $name: ok"
  else
    FAILED+=("$name")
    echo "[satellites] $PHASE $name: FAILED — $(tail -1 "$LOG_DIR/$name.$PHASE.log")"
  fi
done
if ((${#FAILED[@]})); then
  echo "[satellites] $PHASE failed for: ${FAILED[*]} (logs: $LOG_DIR)"
  exit 1
fi
