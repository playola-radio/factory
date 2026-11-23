#!/usr/bin/env bash
# Starts `factory watch`. launchd gives a bare environment, so this sources the hand-written per-machine
# ~/.factory/env first (nvm Node, Homebrew Ruby, Java, ANDROID_HOME, Maestro), then ~/.factory/secrets.env, and then runs the watcher from
# this same checkout, so the watcher and the builds it starts always run the same code.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
FACTORY_HOME="${FACTORY_HOME:-$HOME/.factory}"

if [ -f "$FACTORY_HOME/env" ]; then
  # shellcheck disable=SC1091
  source "$FACTORY_HOME/env"
fi

# FACTORY_REPORT_TOKEN for reporting to marge. `set -a` exports plain NAME=value lines to the watcher.
if [ -f "$FACTORY_HOME/secrets.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$FACTORY_HOME/secrets.env"
  set +a
fi

exec "$REPO_DIR/bin/factory.ts" watch
