#!/usr/bin/env bash
# Build each architecture-viewer board's drift report and hand it to the dev
# agent, so the 03:30 gardener and the Monday weekly digest can read it as
# /workspace/digests/architecture-drift-<board>.json.
#
#   architecture-drift.sh
#
# Runs `node viewer/drift.mjs --board <id>` in the viewer container, which
# compares the specs at the commit it serves with the code at that commit and
# also keeps the report for its /board/<id>/drift.json and header badge. The
# report holds only paths and spec ids, but the copies follow the digest's 0640.
# One board failing does not stop the others; the script then exits non-zero.
#
# Overrides (for fixtures): SEECODE_BOARDS_FILE, ARCHITECTURE_DRIFT_CMD,
# ARCHITECTURE_DRIFT_DEST, ARCHITECTURE_DRIFT_INSTALL. Output is appended to
# $ARCHITECTURE_DRIFT_LOG.
#
# Runs nightly at 03:20, after factory-review and before the 03:30 gardener,
# from the systemd user timer in scripts/systemd/. Its own timer keeps a failure
# here out of the factory digest.
#
#   ln -sf ~/openclaw/scripts/systemd/architecture-drift.{service,timer} ~/.config/systemd/user/
#   systemctl --user daemon-reload && systemctl --user enable --now architecture-drift.timer
set -euo pipefail

BOARDS="${SEECODE_BOARDS_FILE:-$HOME/.config/seecode-viewer/boards.json}"
DRIFT_CMD="${ARCHITECTURE_DRIFT_CMD:-docker exec seecode-viewer-viewer-1 node viewer/drift.mjs}"
DEST="${ARCHITECTURE_DRIFT_DEST:-/home/openclaw/.openclaw/workspace/factory/digests}"
INSTALL="${ARCHITECTURE_DRIFT_INSTALL:-sudo -n install -D -o openclaw -g openclaw -m 0640}"
LOG="${ARCHITECTURE_DRIFT_LOG:-$HOME/logs/architecture-drift.log}"

mkdir -p "$(dirname "$LOG")"
exec >>"$LOG" 2>&1
echo "== drift $(date -Is)"

boards=$(python3 -c 'import json, sys; print("\n".join(json.load(open(sys.argv[1]))))' "$BOARDS")
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
status=0
while read -r board; do
  # Word splitting of the command string is intended: it is a command line.
  # shellcheck disable=SC2086
  if ! $DRIFT_CMD --board "$board" >"$tmp/$board.json"; then
    echo "$board: drift failed"
    status=1
    continue
  fi
  # shellcheck disable=SC2086
  $INSTALL "$tmp/$board.json" "$DEST/architecture-drift-$board.json"
  echo "$board: $(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["summary"]["text"])' "$tmp/$board.json")"
done <<<"$boards"
exit "$status"
