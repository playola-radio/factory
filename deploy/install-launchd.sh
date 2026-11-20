#!/usr/bin/env bash
# Renders the two launchd plists with this machine's paths and loads them. Safe to run again: it boots out an
# existing copy of each label before loading. Writes nothing outside ~/Library/LaunchAgents and $FACTORY_HOME.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
FACTORY_HOME="${FACTORY_HOME:-$HOME/.factory}"
AGENTS_DIR="$HOME/Library/LaunchAgents"
LABELS=(com.playola.factory-watch com.playola.factory-updater)

mkdir -p "$AGENTS_DIR" "$FACTORY_HOME"

# Escape XML metacharacters so a path containing & < > stays valid inside the plist.
xml_escape() {
  local s=$1
  s=${s//&/&amp;}
  s=${s//</&lt;}
  s=${s//>/&gt;}
  printf '%s' "$s"
}
repo_xml="$(xml_escape "$REPO_DIR")"
home_xml="$(xml_escape "$FACTORY_HOME")"

for label in "${LABELS[@]}"; do
  template="$SCRIPT_DIR/$label.plist.template"
  target="$AGENTS_DIR/$label.plist"
  # Literal bash replacement (not sed): the substituted paths are data, never patterns, so &, #, and \ are safe.
  content="$(cat "$template")"
  content=${content//__REPO_DIR__/$repo_xml}
  content=${content//__FACTORY_HOME__/$home_xml}
  printf '%s\n' "$content" > "$target"
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$target"
  echo "loaded $label -> $target"
done

echo
echo "Done. Watcher log: $FACTORY_HOME/watch.log   Updater log: $FACTORY_HOME/updater.log"
echo "Before it can do anything, create $FACTORY_HOME/watch.json (the repos to watch)."
echo "If the agents need extra PATH/env, create $FACTORY_HOME/env (sourced by run-watch.sh; not in the repo)."
