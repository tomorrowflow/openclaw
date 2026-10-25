#!/usr/bin/env bash
# Fetch each architecture-viewer board's clone, so the viewer container (which
# mounts the clones read-only and never fetches) renders a merged map within
# minutes.
#
#   architecture-refresh.sh
#
# Board repos come from the viewer's boards.json, where each "repo" is a path
# under /repos inside the container; it maps to $REPOS_DIR on the host. A clone
# missing on the host is cloned from the board's "github" owner/name.
#
# Overrides: SEECODE_BOARDS_FILE, SEECODE_REPOS_DIR. Failures are appended to
# $ARCHITECTURE_REFRESH_LOG; a quiet run writes nothing.
#
# Runs every 10 minutes at :07, :17, ... from the systemd user timer in
# scripts/systemd/, off the :00 and :15 starts of factory-digest and
# factory-review, which fetch the same clone. A fetch that still collides
# fails on git's ref lock and is retried by the next run.
#
#   ln -sf ~/openclaw/scripts/systemd/architecture-refresh.{service,timer} ~/.config/systemd/user/
#   systemctl --user daemon-reload && systemctl --user enable --now architecture-refresh.timer
set -euo pipefail
BOARDS="${SEECODE_BOARDS_FILE:-$HOME/.config/seecode-viewer/boards.json}"
REPOS_DIR="${SEECODE_REPOS_DIR:-$HOME/factory-repos}"
LOG="${ARCHITECTURE_REFRESH_LOG:-$HOME/logs/architecture-refresh.log}"

mkdir -p "$(dirname "$LOG")"
boards=$(python3 - "$BOARDS" <<'PY'
import json, sys
for board, b in json.load(open(sys.argv[1])).items():
    repo = b["repo"]
    if not repo.startswith("/repos/"):
        sys.exit(f"{board}: repo {repo} is not under /repos/")
    print(board, repo[len("/repos/"):], b.get("github", ""), sep="\t")
PY
)
status=0
while IFS=$'\t' read -r board rel github; do
  clone="$REPOS_DIR/$rel"
  if [ ! -d "$clone/.git" ]; then
    if [ -z "$github" ]; then
      echo "$(date -Is) $board: no clone at $clone and no github to clone from" >>"$LOG"
      status=1
      continue
    fi
    git clone -q "https://github.com/$github" "$clone" 2>>"$LOG" || { status=1; continue; }
  fi
  if ! out=$(git -C "$clone" fetch -q origin 2>&1); then
    echo "$(date -Is) $board: fetch failed: $out" >>"$LOG"
    status=1
  fi
done <<<"$boards"
exit "$status"
