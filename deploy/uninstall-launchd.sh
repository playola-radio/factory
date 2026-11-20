#!/usr/bin/env bash
# Unloads and removes both launchd agents. Safe to run again: missing labels and files are ignored.
set -euo pipefail

AGENTS_DIR="$HOME/Library/LaunchAgents"
LABELS=(com.playola.factory-watch com.playola.factory-updater)

for label in "${LABELS[@]}"; do
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  rm -f "$AGENTS_DIR/$label.plist"
  echo "removed $label"
done
