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
# The node dir also mirrors the node user's skill metadata at the same paths
# under ~/.claude/, so agentplay can tell which skills a node had installed:
# skills/**/SKILL.md, commands/**/*.md, plugins/installed_plugins.json, and
# under plugins/cache/ and plugins/synced/ each .claude-plugin/plugin.json,
# skills/**/SKILL.md and commands/**/*.md. Nothing else (settings, credentials,
# history, plugin data) is copied. This mirror is exact: a skill removed on the
# node disappears here. --delete never reaches projects/, which the filter
# excludes. <node>/skills-pulled-at holds the UTC time of the last successful
# skill pull.
#
# Reaching the node user mirrors deploy-satellites.sh: local-systemd through
# sudo, linux-tarball over SSH then sudo, macos-source over SSH as the node user.
# An unreachable node (a sleeping Mac) does not stop the others; the script
# reports it and exits 1. Output is appended to $FACTORY_TRANSCRIPTS_LOG.
# For fixtures, FACTORY_CLAUDE_DIR replaces the node's ~/.claude and
# FACTORY_PROJECTS_DIR its ~/.claude/projects, on every node.
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

# Allow-list of the skill metadata above; "- *" excludes everything else, so
# --delete leaves projects/ and skills-pulled-at alone. --copy-dirlinks follows
# a skill dir that is a symlink into a checkout.
SKILLS_MIRROR=(
  --delete --prune-empty-dirs --copy-dirlinks
  --filter='+ /skills/' --filter='+ /skills/**/' --filter='+ /skills/**/SKILL.md'
  --filter='+ /commands/' --filter='+ /commands/**/' --filter='+ /commands/**.md'
  --filter='+ /plugins/' --filter='+ /plugins/installed_plugins.json'
)
for dir in /plugins/cache /plugins/synced; do
  SKILLS_MIRROR+=(
    --filter="+ $dir/" --filter="+ $dir/**/"
    --filter="+ $dir/**/.claude-plugin/plugin.json"
    --filter="+ $dir/**/skills/**/SKILL.md"
    --filter="+ $dir/**/commands/**.md"
  )
done
SKILLS_MIRROR+=(--filter='- *')

pull_one() {
  local name="$1" kind="$2" host="$3" claude transport
  case "$kind" in
    local-systemd)
      claude="$(getent passwd "$host" | cut -d: -f6)/.claude"
      # rsync's "remote shell" here drops the host argument and runs the
      # sender as the node user (its home is not readable by us).
      transport=(-e "sh -c 'shift; exec sudo -n -u $host \"\$@\"' _")
      host=local
      ;;
    linux-tarball)
      claude=/home/$NODE_USER/.claude
      transport=(-e "$SSH" --rsync-path="sudo -n -u $NODE_USER rsync")
      ;;
    macos-source)
      claude=.claude
      transport=(-e "$SSH")
      ;;
    *) echo "unknown kind $kind" >&2; return 1 ;;
  esac
  claude="${FACTORY_CLAUDE_DIR:-$claude}"
  local node="$ARCHIVE/$name"
  mkdir -p "$node/projects"
  "${RSYNC[@]}" "${transport[@]}" \
    "$host:${FACTORY_PROJECTS_DIR:-$claude/projects}/" "$node/projects/" || return
  "${RSYNC[@]}" "${transport[@]}" "${SKILLS_MIRROR[@]}" "$host:$claude/" "$node/" || return
  ((${#DRY_RUN[@]})) || date -u +%Y-%m-%dT%H:%M:%SZ >"$node/skills-pulled-at"
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
