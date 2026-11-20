#!/usr/bin/env bash
# Runs every couple of minutes from launchd. Fetches origin/main; if this checkout is behind, waits for any
# agent to go quiet (so an update never throws away a run), fast-forwards, and restarts the watcher so it picks
# up the new code. KeepAlive on the watcher brings it back. Safe to run again at any time.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
FACTORY_HOME="${FACTORY_HOME:-$HOME/.factory}"
WATCH_LABEL="com.playola.factory-watch"
QUIET_FOR_MINUTES=2
MAX_WAIT_MINUTES=45

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }

cd "$REPO_DIR"
git fetch -q origin main
local_head="$(git rev-parse HEAD)"
remote_head="$(git rev-parse origin/main)"
if [ "$local_head" = "$remote_head" ]; then
  exit 0
fi
log "origin/main moved ${local_head:0:7} -> ${remote_head:0:7}; checking for active agents before updating"

# An agent streams its output under $FACTORY_HOME/runs/. If any trace file changed in the last couple of
# minutes an agent is working; wait (up to the cap) rather than kill its run. A build only waiting on the owner
# writes no trace, so it never delays us.
deadline=$(( $(date +%s) + MAX_WAIT_MINUTES * 60 ))
while [ -d "$FACTORY_HOME/runs" ]; do
  marker="$(mktemp)"
  touch -t "$(date -v-"${QUIET_FOR_MINUTES}"M +%Y%m%d%H%M.%S)" "$marker"
  recent="$(find "$FACTORY_HOME/runs" -type f -newer "$marker" 2>/dev/null | head -1 || true)"
  rm -f "$marker"
  [ -z "$recent" ] && break
  if [ "$(date +%s)" -ge "$deadline" ]; then
    log "agents still active after ${MAX_WAIT_MINUTES} minutes; updating anyway"
    break
  fi
  log "an agent is still writing traces; waiting 30s"
  sleep 30
done

if ! git merge --ff-only origin/main; then
  log "cannot fast-forward (this checkout has diverged from origin/main); leaving it for a person"
  exit 1
fi
log "fast-forwarded to ${remote_head:0:7}; restarting the watcher"
launchctl kill TERM "gui/$(id -u)/${WATCH_LABEL}" 2>/dev/null \
  || launchctl kill TERM "${WATCH_LABEL}" 2>/dev/null \
  || log "could not signal ${WATCH_LABEL} (is it loaded?)"
log "sent TERM to ${WATCH_LABEL}; KeepAlive will restart it on the new code"
