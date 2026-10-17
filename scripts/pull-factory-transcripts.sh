#!/usr/bin/env bash
# Copy every factory node's Claude Code transcripts into a private archive on
# the Gateway host, so a ticket run can be read long after its node deleted the
# worktree (and, after cleanupPeriodDays, the transcript).
#
#   pull-factory-transcripts.sh [--dry-run]
#
# For each satellite in $OPENCLAW_SATELLITES_FILE (the same file
# deploy-satellites.sh reads), the node user's ~/.claude/projects/ lands in
# $FACTORY_TRANSCRIPTS_DIR/<node name>/projects/, so each node dir works as a
# Claude home (agentplay's AGENTPLAY_CLAUDE_HOMES). The copy is append-only (no
# --delete): a transcript a node has pruned stays in the archive, and a rerun
# changes nothing. The archive holds every prompt from every node, so it is
# kept 0700.
#
# Reaching the node user mirrors deploy-satellites.sh: local-systemd through
# sudo, linux-tarball over SSH then sudo, macos-source over SSH as the node user.
# An unreachable node (a sleeping Mac) does not stop the others; the script
# reports it and exits 1. Output is appended to $FACTORY_TRANSCRIPTS_LOG.
# FACTORY_PROJECTS_DIR replaces the source path on every node (for fixtures).
#
# Runs nightly at 02:30 from the systemd user timer in scripts/systemd/:
#
#   ln -sf ~/openclaw/scripts/systemd/pull-factory-transcripts.{service,timer} ~/.config/systemd/user/
#   systemctl --user daemon-reload && systemctl --user enable --now pull-factory-transcripts.timer
#   sudo loginctl enable-linger "$USER"   # user timers only fire while you're logged in otherwise
set -euo pipefail

DRY_RUN=()
case "${1:-}" in
  "") ;;
  --dry-run) DRY_RUN=(--dry-run) ;;
  *) echo "usage: $(basename "$0") [--dry-run]" >&2; exit 2 ;;
esac

SATELLITES_FILE="${OPENCLAW_SATELLITES_FILE:-$HOME/.config/openclaw-deploy/satellites.conf}"
ARCHIVE="${FACTORY_TRANSCRIPTS_DIR:-$HOME/factory-transcripts}"
LOG="${FACTORY_TRANSCRIPTS_LOG:-$HOME/logs/factory-transcripts.log}"
NODE_USER=factory
SSH="ssh -o BatchMode=yes -o ConnectTimeout=10"

mkdir -p "$(dirname "$LOG")"
exec >>"$LOG" 2>&1
echo "== pull ${DRY_RUN[*]:-} $(date -Is)"

if [[ ! -f "$SATELLITES_FILE" ]]; then
  echo "no $SATELLITES_FILE; nothing to do"
  exit 0
fi
umask 077
mkdir -p "$ARCHIVE"
chmod 700 "$ARCHIVE"

exec 9>"$ARCHIVE/.lock"
flock -n 9 || { echo "another pull holds $ARCHIVE/.lock; skipping"; exit 0; }

# The sending side runs as the node user; this side keeps everything private.
RSYNC=(rsync -a --chmod=Du=rwx,Dgo=,Fu=rw,Fgo= "${DRY_RUN[@]}" --itemize-changes)

pull_one() {
  local name="$1" kind="$2" target="$3"
  local dest="$ARCHIVE/$name/projects/"
  mkdir -p "$dest"
  case "$kind" in
    local-systemd)
      local home
      home=$(getent passwd "$target" | cut -d: -f6)
      # rsync's "remote shell" here drops the host argument and runs the
      # sender as the node user (its home is not readable by us).
      "${RSYNC[@]}" -e "sh -c 'shift; exec sudo -n -u $target \"\$@\"' _" \
        "local:${FACTORY_PROJECTS_DIR:-$home/.claude/projects}/" "$dest"
      ;;
    linux-tarball)
      "${RSYNC[@]}" -e "$SSH" --rsync-path="sudo -n -u $NODE_USER rsync" \
        "$target:${FACTORY_PROJECTS_DIR:-/home/$NODE_USER/.claude/projects}/" "$dest"
      ;;
    macos-source)
      "${RSYNC[@]}" -e "$SSH" "$target:${FACTORY_PROJECTS_DIR:-.claude/projects}/" "$dest"
      ;;
    *) echo "unknown kind $kind" >&2; return 1 ;;
  esac
}

FAILED=()
while read -r name kind target _; do
  [[ -z "${name:-}" || "$name" == \#* ]] && continue
  echo "-- $name ($kind $target)"
  # </dev/null: ssh would otherwise read the rest of the satellites file.
  if ! pull_one "$name" "$kind" "$target" </dev/null; then
    FAILED+=("$name")
  fi
done <"$SATELLITES_FILE"

if ((${#FAILED[@]})); then
  echo "pull failed for: ${FAILED[*]}"
  exit 1
fi
echo "pull ok"
