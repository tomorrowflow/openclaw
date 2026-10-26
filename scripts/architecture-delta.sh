#!/usr/bin/env bash
# Build each architecture-viewer board's weekly architecture delta and hand it
# to the dev agent, so the Monday weekly digest can read it as
# /workspace/digests/architecture-delta-<board>.json.
#
#   architecture-delta.sh
#
# Runs `node viewer/delta.mjs --board <id> --since <Mon> --until <Mon>` in the
# viewer container for the previous ISO week (Monday 00:00 to Monday 00:00,
# Europe/Berlin), the week the digest reports on. The delta lists what changed
# in the board's specs: specs, nodes, edges and evidence added, removed or
# changed. One board failing does not stop the others; the script then exits
# non-zero.
#
# Overrides (for fixtures): SEECODE_BOARDS_FILE, ARCHITECTURE_DELTA_CMD,
# ARCHITECTURE_DELTA_DEST, ARCHITECTURE_DELTA_INSTALL, ARCHITECTURE_DELTA_TODAY
# (a date in the week after the one to report). Output is appended to
# $ARCHITECTURE_DELTA_LOG.
#
# Runs Mondays at 08:00, before the 08:15 weekly digest, from the systemd user
# timer in scripts/systemd/:
#
#   ln -sf ~/openclaw/scripts/systemd/architecture-delta.{service,timer} ~/.config/systemd/user/
#   systemctl --user daemon-reload && systemctl --user enable --now architecture-delta.timer
set -euo pipefail

BOARDS="${SEECODE_BOARDS_FILE:-$HOME/.config/seecode-viewer/boards.json}"
DELTA_CMD="${ARCHITECTURE_DELTA_CMD:-docker exec seecode-viewer-viewer-1 node viewer/delta.mjs}"
DEST="${ARCHITECTURE_DELTA_DEST:-/home/openclaw/.openclaw/workspace/factory/digests}"
INSTALL="${ARCHITECTURE_DELTA_INSTALL:-sudo -n install -D -o openclaw -g openclaw -m 0640}"
LOG="${ARCHITECTURE_DELTA_LOG:-$HOME/logs/architecture-delta.log}"
export TZ=Europe/Berlin
today="${ARCHITECTURE_DELTA_TODAY:-$(date +%F)}"
monday=$(date -d "$today -$(($(date -d "$today" +%u) - 1)) days" +%F)
since=$(date -d "$monday -7 days 00:00" --iso-8601=seconds)
until=$(date -d "$monday 00:00" --iso-8601=seconds)

mkdir -p "$(dirname "$LOG")"
exec >>"$LOG" 2>&1
echo "== delta $(date -Is) for $since .. $until"

boards=$(python3 -c 'import json, sys; print("\n".join(json.load(open(sys.argv[1]))))' "$BOARDS")
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
status=0
while read -r board; do
  # Word splitting of the command string is intended: it is a command line.
  # shellcheck disable=SC2086
  if ! $DELTA_CMD --board "$board" --since "$since" --until "$until" >"$tmp/$board.json"; then
    echo "$board: delta failed"
    status=1
    continue
  fi
  # shellcheck disable=SC2086
  $INSTALL "$tmp/$board.json" "$DEST/architecture-delta-$board.json"
  echo "$board: $(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["summary"]["text"])' "$tmp/$board.json")"
done <<<"$boards"
exit "$status"
