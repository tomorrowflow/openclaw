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
# When the factory repo's clone exists (the one factory-review.sh keeps), the
# script fetches it and passes it as --repo-path, so the digest can tell whether
# a skill that failed to load was in the repo at the card's base commit. The
# container sees the clone read-only, so the fetch happens here. A failed fetch
# only leaves the clone as it was.
#
# Overrides (for fixtures): WORKBOARD_CARDS_CMD, AGENTPLAY_DIGEST_CMD,
# AGENTPLAY_DIGESTS (where the digest command writes), FACTORY_DIGEST_DEST,
# FACTORY_DIGEST_INSTALL, FACTORY_REVIEW_REPO, FACTORY_REVIEW_CLONE,
# CRON_RUNS_CMD. Output is appended to $FACTORY_DIGEST_LOG.
#
# It also writes cron-usage-latest.json: the dev agent's cron runs of the last
# 7 days per job, with token totals and how many runs ended silent (NO_REPLY,
# so delivery was suppressed). The weekly digest reports it, so a change to a
# review job shows up as tokens per run. A failure here leaves the previous file
# and does not fail the card digest.
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
REPO="${FACTORY_REVIEW_REPO:-tomorrowflow/voice-diary}"
CLONE="${FACTORY_REVIEW_CLONE:-$HOME/factory-repos/${REPO##*/}}"
LOG="${FACTORY_DIGEST_LOG:-$HOME/logs/factory-digest.log}"
RUNS_CMD="${CRON_RUNS_CMD:-sudo -n -u openclaw -i openclaw cron runs --all --sort desc --limit 200 --json}"

mkdir -p "$(dirname "$LOG")"
exec >>"$LOG" 2>&1
echo "== digest $(date -Is)"

REPO_ARGS=()
if [ -d "$CLONE/.git" ]; then
  git -C "$CLONE" fetch -q origin || echo "fetch of $CLONE failed; using it as is"
  REPO_ARGS=(--repo-path "$CLONE")
fi

# Word splitting of the command strings is intended: each is a command line.
# shellcheck disable=SC2086
$CARDS_CMD | $DIGEST_CMD --cards - "${REPO_ARGS[@]}"

for ext in md json; do
  # shellcheck disable=SC2086
  $INSTALL "$DIGESTS/factory-latest.$ext" "$DEST/factory-latest.$ext"
done
echo "digest ok -> $DEST"

# Pages newest first until a page reaches past the window. jq does the counting.
# Called from an || list, where set -e is off, so each step returns on failure.
cron_usage() {
  local since=$(( ($(date +%s) - 7 * 86400) * 1000 )) offset=0 page out
  out="$(mktemp)"
  while :; do
    # shellcheck disable=SC2086
    page="$($RUNS_CMD --offset "$offset" </dev/null)" || return 1
    jq -c '.entries[]' <<<"$page" >>"$out" || return 1
    [ "$(jq -r '.hasMore' <<<"$page")" = true ] || break
    [ "$(jq -r '[.entries[].ts] | min' <<<"$page")" -ge "$since" ] || break
    offset="$(jq -r '.nextOffset' <<<"$page")"
  done
  jq -s --argjson since "$since" '
    map(select(.ts >= $since and .action == "finished" and ((.sessionKey // "") | startswith("agent:dev:"))))
    | {since: $since, until: (now * 1000 | floor), jobs: (group_by(.jobId) | map({
        name: .[0].jobName,
        runs: length,
        silent: map(select(.deliverySuppressionReason == "silent")) | length,
        errors: map(select(.status == "error")) | length,
        totalTokens: map(.usage.total_tokens // 0) | add // 0,
        freshTokens: map((.usage.input_tokens // 0) + (.usage.output_tokens // 0)) | add // 0,
        silentTokens: map(select(.deliverySuppressionReason == "silent") | .usage.total_tokens // 0) | add // 0
      }) | sort_by(-.totalTokens))}' "$out" >"$DIGESTS/cron-usage-latest.json" || return 1
  rm -f "$out"
  # shellcheck disable=SC2086
  $INSTALL "$DIGESTS/cron-usage-latest.json" "$DEST/cron-usage-latest.json" || return 1
}
cron_usage && echo "cron usage ok" || echo "cron usage failed; previous file kept"
