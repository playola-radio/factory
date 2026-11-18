#!/usr/bin/env bash
set -euo pipefail

# Remove the links install.sh made. Leaves real files and links pointing elsewhere alone.

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

removed=0

for link in "$HOME/.claude/skills"/* "$HOME/.codex/skills"/* "$HOME/.local/bin/factory"; do
  [ -L "$link" ] || continue
  case "$(readlink "$link")" in
    "$REPO_DIR"/*)
      rm "$link"
      echo "  removed: $link"
      removed=$((removed + 1))
      ;;
  esac
done

echo ""
echo "Done. $removed symlink(s) removed."
