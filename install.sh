#!/usr/bin/env bash
set -euo pipefail

# Link the factory command into ~/.local/bin and its skills into ~/.claude/skills
# and ~/.codex/skills. Safe to re-run.

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

linked=0
skipped=0

link() {
  local source="$1" target="$2"
  if [ -L "$target" ]; then
    ln -sfn "$source" "$target"
    echo "  refreshed: $target"
    linked=$((linked + 1))
  elif [ -e "$target" ]; then
    echo "  SKIP (not a symlink): $target — rename or remove it manually"
    skipped=$((skipped + 1))
  else
    ln -s "$source" "$target"
    echo "  linked:    $target"
    linked=$((linked + 1))
  fi
}

for target_root in "$HOME/.claude/skills" "$HOME/.codex/skills"; do
  mkdir -p "$target_root"
  for skill_dir in "$REPO_DIR"/skills/*/; do
    skill_dir="${skill_dir%/}"
    [ -f "$skill_dir/SKILL.md" ] || continue
    link "$skill_dir" "$target_root/$(basename "$skill_dir")"
  done
done

mkdir -p "$HOME/.local/bin"
link "$REPO_DIR/bin/factory.ts" "$HOME/.local/bin/factory"

echo ""
echo "Done. $linked link(s) created/refreshed, $skipped skipped."
