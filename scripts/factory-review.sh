#!/usr/bin/env bash
# Trace each published factory card's review findings to the session edits that
# wrote the lines, as agentplay review docs the viewer shows in a session's
# Review tab.
#
#   factory-review.sh
#
# Exports the Workboard cards as the openclaw user and pipes them into
# `agentplay factory-review` on the host. It runs on the host, not in the
# agentplay container, because the review reads file contents with git: the
# container has no git, and the gateway's clone is readable only by openclaw.
# So it keeps its own clone of the cards' PR repository, fetched each run. It
# writes only $AGENTPLAY_HOME/reviews/, which is safe beside the container's
# scan, and never writes to the board.
#
# Overrides (for fixtures): WORKBOARD_CARDS_CMD, AGENTPLAY_REVIEW_CMD,
# FACTORY_REVIEW_REPO (owner/name), FACTORY_REVIEW_CLONE. Output is appended to
# $FACTORY_REVIEW_LOG.
#
# Runs nightly at 03:15, after the 02:30 transcript pull and the 03:00 digest,
# from the systemd user timer in scripts/systemd/:
#
#   ln -sf ~/openclaw/scripts/systemd/factory-review.{service,timer} ~/.config/systemd/user/
#   systemctl --user daemon-reload && systemctl --user enable --now factory-review.timer
set -euo pipefail

CARDS_CMD="${WORKBOARD_CARDS_CMD:-sudo -n -u openclaw -i openclaw workboard list --json}"
REVIEW_CMD="${AGENTPLAY_REVIEW_CMD:-env PYTHONPATH=$HOME/agentplay/python/src python3 -m agentplay factory-review}"
REPO="${FACTORY_REVIEW_REPO:-tomorrowflow/voice-diary}"
CLONE="${FACTORY_REVIEW_CLONE:-$HOME/factory-repos/${REPO##*/}}"
LOG="${FACTORY_REVIEW_LOG:-$HOME/logs/factory-review.log}"

mkdir -p "$(dirname "$LOG")"
exec >>"$LOG" 2>&1
echo "== review $(date -Is)"

if [ ! -d "$CLONE/.git" ]; then
  git clone -q "https://github.com/$REPO" "$CLONE"
fi
git -C "$CLONE" fetch -q origin

# Word splitting of the command strings is intended: each is a command line.
# shellcheck disable=SC2086
$CARDS_CMD | $REVIEW_CMD --cards - --repo-path "$CLONE"
echo "review ok"
