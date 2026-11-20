#!/usr/bin/env bash
# Starts `factory watch`. launchd gives a bare environment, so this sources the hand-written per-machine
# ~/.factory/env first (nvm Node, Homebrew Ruby, Java, ANDROID_HOME, Maestro) and then runs the watcher from
# this same checkout, so the watcher and the builds it starts always run the same code.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
FACTORY_HOME="${FACTORY_HOME:-$HOME/.factory}"

if [ -f "$FACTORY_HOME/env" ]; then
  # shellcheck disable=SC1091
  source "$FACTORY_HOME/env"
fi

exec "$REPO_DIR/bin/factory.ts" watch
