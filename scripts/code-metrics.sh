#!/usr/bin/env bash
# Build each configured board's code-metrics digest for the dev agent, so the
# 03:30 gardener can read it as /workspace/digests/code-metrics-<board>.md.
#
#   code-metrics.sh
#
# For each board in $CODE_METRICS_BOARDS_FILE, fetches its repo into a cache
# checkout at origin/HEAD, runs the board's coverage command (which writes
# target/coverage/<language>/lcov.info), then scores the board's source files
# with crapper (CRAP = CC^2 * (1 - coverage)^3 + CC) and dryer (structural
# duplication) from the node profile's factory-metrics image, the same pin the
# ticket sessions use. Report only: nothing here gates a ticket.
#
#   {"voice-diary": {"repo": "https://github.com/<owner>/<name>.git",
#                    "coverage": "<shell command run from the checkout root>",
#                    "sources": ["<git pathspec>", ...]}}
#
# One board failing does not stop the others; the script then exits non-zero.
# Overrides (for fixtures): CODE_METRICS_BOARDS_FILE, CODE_METRICS_CACHE,
# CODE_METRICS_DEST, CODE_METRICS_INSTALL, CODE_METRICS_IMAGE. Output is
# appended to $CODE_METRICS_LOG.
#
# Runs nightly at 03:05, after the factory digest and before the 03:30
# gardener, from the systemd user timer in scripts/systemd/:
#
#   ln -sf ~/openclaw/scripts/systemd/code-metrics.{service,timer} ~/.config/systemd/user/
#   systemctl --user daemon-reload && systemctl --user enable --now code-metrics.timer
set -euo pipefail

BOARDS="${CODE_METRICS_BOARDS_FILE:-$HOME/.config/code-metrics/boards.json}"
CACHE="${CODE_METRICS_CACHE:-$HOME/.cache/code-metrics}"
DEST="${CODE_METRICS_DEST:-/home/openclaw/.openclaw/workspace/factory/digests}"
INSTALL="${CODE_METRICS_INSTALL:-sudo -n install -D -o openclaw -g openclaw -m 0640}"
LOG="${CODE_METRICS_LOG:-$HOME/logs/code-metrics.log}"
IMAGE="${CODE_METRICS_IMAGE:-$("$HOME/.config/openclaw-deploy/node-profile/metrics/build.sh" --tag)}"
CRAP_THRESHOLD=10
TOP=25

mkdir -p "$(dirname "$LOG")" "$CACHE"
exec >>"$LOG" 2>&1
echo "== code-metrics $(date -Is) $IMAGE"

field() { python3 -c 'import json, sys; v = json.load(open(sys.argv[1]))[sys.argv[2]][sys.argv[3]]; print("\n".join(v) if isinstance(v, list) else v)' "$BOARDS" "$1" "$2"; }
# The coverage container writes as root; clear its output with the same rootful engine.
scrub() { docker run --rm -v "$1:/repo" "$IMAGE" rm -rf /repo/target /repo/.metrics; }

digest() {
  local board="$1" dir="$CACHE/$1" out="$2"
  if [[ ! -d "$dir/.git" ]]; then
    git clone -q "$(field "$board" repo)" "$dir"
  fi
  git -C "$dir" fetch -q --prune origin
  git -C "$dir" remote set-head origin --auto >/dev/null
  git -C "$dir" checkout -q --detach origin/HEAD
  scrub "$dir"
  local -a pathspecs files
  mapfile -t pathspecs < <(field "$board" sources)
  mapfile -t files < <(git -C "$dir" ls-files -- "${pathspecs[@]}")
  (cd "$dir" && bash -c "$(field "$board" coverage)") || echo "$board: coverage command failed; uncovered functions score 0%"
  local run=(docker run --rm --network none --user "$(id -u):$(id -g)" -v "$dir:/repo" "$IMAGE")
  "${run[@]}" crapper --use-existing-coverage "${files[@]}" >"$out.crap"
  "${run[@]}" dryer "${files[@]}" >"$out.dry"
  scrub "$dir"

  local over total pairs
  total=$(awk '/^-+$/ {t = 1; next} t && NF' "$out.crap" | wc -l)
  over=$(awk -v th="$CRAP_THRESHOLD" '/^-+$/ {t = 1; next} t && NF && $NF + 0 >= th' "$out.crap" | wc -l)
  pairs=$(grep -c '^DUPLICATE' "$out.dry" || true)
  {
    echo "# Code metrics: $board"
    echo
    echo "- Commit: \`$(git -C "$dir" rev-parse --short=12 HEAD)\` ($(git -C "$dir" log -1 --format=%cs))"
    echo "- Generated: $(date -Is)"
    echo "- Tools: \`$IMAGE\`, over ${#files[@]} files matching \`${pathspecs[*]}\`"
    echo "- CRAP >= $CRAP_THRESHOLD: $over of $total functions"
    echo "- Duplicate pairs (dryer, score >= 0.82, >= 4 lines): $pairs"
    echo
    echo "## Worst CRAP scores (top $TOP)"
    echo
    echo '```'
    awk -v top="$TOP" '/^-+$/ {t = 1; print; next} !t && NF {print; next} t && NF && n++ < top' "$out.crap" | sed -n '/^Function/,$p'
    echo '```'
    echo
    echo "## Closest duplicates (top $TOP)"
    echo
    echo '```'
    awk -v top="$TOP" '/^DUPLICATE/ {n++} n > top {exit} {print}' "$out.dry"
    echo '```'
  } >"$out"
  rm -f "$out.crap" "$out.dry"
  echo "$board: $over/$total functions CRAP >= $CRAP_THRESHOLD, $pairs duplicate pairs"
}

boards=$(python3 -c 'import json, sys; print("\n".join(json.load(open(sys.argv[1]))))' "$BOARDS")
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
status=0
while read -r board; do
  # In the background errexit still applies inside digest; under `if` it would not.
  digest "$board" "$tmp/$board.md" &
  if ! wait $!; then
    echo "$board: code metrics failed"
    status=1
    continue
  fi
  # shellcheck disable=SC2086
  $INSTALL "$tmp/$board.md" "$DEST/code-metrics-$board.md"
done <<<"$boards"
exit "$status"
