#!/usr/bin/env bash
set -euo pipefail

AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
TARGET_DIR="$AGENT_DIR/extensions/forge-for-pi"
LAUNCHER_DIR="$HOME/.local/bin"
PATH_BLOCK_START="# >>> Forge for Pi >>>"
PATH_BLOCK_LINE='export PATH="$HOME/.local/bin:$PATH"'
PATH_BLOCK_END="# <<< Forge for Pi <<<"

is_forge_launcher() {
  [ -f "$1" ] && [ ! -L "$1" ] && grep -Fqx '# Managed by Forge for Pi' "$1"
}

remove_launcher() {
  local path="$LAUNCHER_DIR/$1"
  if [ -e "$path" ] || [ -L "$path" ]; then
    if is_forge_launcher "$path"; then
      rm -f "$path"
      echo "Removed Forge launcher $path"
    else
      echo "Preserved non-Forge launcher $path" >&2
    fi
  fi
}

managed_path_block_is_exact() {
  local file="$1" starts ends
  starts="$(grep -Fxc "$PATH_BLOCK_START" "$file" 2>/dev/null || true)"
  ends="$(grep -Fxc "$PATH_BLOCK_END" "$file" 2>/dev/null || true)"
  [ "$starts" = 1 ] && [ "$ends" = 1 ] || return 1
  awk -v start="$PATH_BLOCK_START" -v line="$PATH_BLOCK_LINE" -v end="$PATH_BLOCK_END" '
    BEGIN { valid = 1 }
    $0 == start { found++; if (getline next_line <= 0 || next_line != line) valid = 0; else if (getline next_line <= 0 || next_line != end) valid = 0 }
    END { exit (found == 1 && valid) ? 0 : 1 }
  ' "$file"
}

remove_path_block() {
  local file="$1" temporary
  [ -f "$file" ] && [ ! -L "$file" ] || return 0
  if ! grep -Fq "$PATH_BLOCK_START" "$file" && ! grep -Fq "$PATH_BLOCK_END" "$file"; then
    return 0
  fi
  if ! managed_path_block_is_exact "$file"; then
    echo "Preserved ambiguous Forge PATH markers in $file" >&2
    return 0
  fi
  temporary="$(mktemp "${file}.forge.XXXXXX")"
  awk -v start="$PATH_BLOCK_START" -v end="$PATH_BLOCK_END" '
    $0 == start { skip = 1; next }
    $0 == end && skip { skip = 0; next }
    !skip { print }
  ' "$file" > "$temporary"
  mv -f "$temporary" "$file"
  echo "Removed Forge PATH block from $file"
}

if [ -e "$TARGET_DIR" ] || [ -L "$TARGET_DIR" ]; then
  rm -rf "$TARGET_DIR"
  echo "Removed Forge for Pi from $TARGET_DIR"
else
  echo "Forge for Pi is not installed at $TARGET_DIR"
fi

remove_launcher Forge
remove_launcher Forgetrace
remove_path_block "$HOME/.zshrc"
remove_path_block "$HOME/.bashrc"
