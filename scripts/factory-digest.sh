#!/usr/bin/env bash
# Build agentplay's per-card factory digest and hand it to the dev agent, so the
# 03:30 gardener and the Monday weekly digest can read it as
# /workspace/digests/factory-latest.{md,json}.
#
#   factory-digest.sh
#
# Exports the Workboard cards as the openclaw user, pipes them into
# `agentplay factory-digest` in the agentplay container (which reads the maps
# built from ~/factory-transcripts), then installs the day's Markdown and JSON
# into the dev workspace owned by openclaw. The digest holds card titles, so the
# copies are 0640. It only reads the board; it never writes to it.
#
# Overrides (for fixtures): WORKBOARD_CARDS_CMD, AGENTPLAY_DIGEST_CMD,
# AGENTPLAY_DIGESTS (where the digest command writes), FACTORY_DIGEST_DEST,
# FACTORY_DIGEST_INSTALL. Output is appended to $FACTORY_DIGEST_LOG.
#
# Runs nightly at 03:00, after the 02:30 transcript pull, from the systemd user
# timer in scripts/systemd/:
#
#   ln -sf ~/openclaw/scripts/systemd/factory-digest.{service,timer} ~/.config/systemd/user/
#   systemctl --user daemon-reload && systemctl --user enable --now factory-digest.timer
set -euo pipefail

CARDS_CMD="${WORKBOARD_CARDS_CMD:-sudo -n -u openclaw -i openclaw workboard list --json}"
DIGEST_CMD="${AGENTPLAY_DIGEST_CMD:-docker exec -i apverify-agentplay-1 agentplay factory-digest}"
DIGESTS="${AGENTPLAY_DIGESTS:-$HOME/.agentplay/digests}"
DEST="${FACTORY_DIGEST_DEST:-/home/openclaw/.openclaw/workspace/factory/digests}"
INSTALL="${FACTORY_DIGEST_INSTALL:-sudo -n install -D -o openclaw -g openclaw -m 0640}"
LOG="${FACTORY_DIGEST_LOG:-$HOME/logs/factory-digest.log}"

mkdir -p "$(dirname "$LOG")"
exec >>"$LOG" 2>&1
echo "== digest $(date -Is)"

# Word splitting of the command strings is intended: each is a command line.
# shellcheck disable=SC2086
$CARDS_CMD | $DIGEST_CMD --cards -

for ext in md json; do
  # shellcheck disable=SC2086
  $INSTALL "$DIGESTS/factory-latest.$ext" "$DEST/factory-latest.$ext"
done
echo "digest ok -> $DEST"
