#!/usr/bin/env bash
set -euo pipefail

VERSION="1.0.2"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
source "$SCRIPT_DIR/pi-checks.sh"
SOURCE_DIR="$(CDPATH= cd -- "$SCRIPT_DIR/../src/forge-for-pi" && pwd)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
EXTENSIONS_DIR="$AGENT_DIR/extensions"
TARGET_DIR="$EXTENSIONS_DIR/forge-for-pi"
BACKUP_DIR="$AGENT_DIR/forge-for-pi-backups"
LAUNCHER_DIR="$HOME/.local/bin"
PATH_BLOCK_START="# >>> Forge for Pi >>>"
PATH_BLOCK_LINE='export PATH="$HOME/.local/bin:$PATH"'
PATH_BLOCK_END="# <<< Forge for Pi <<<"

fail() { echo "$*" >&2; exit 1; }

is_forge_launcher() {
  [ -f "$1" ] && [ ! -L "$1" ] && grep -Fqx '# Managed by Forge for Pi' "$1"
}

assert_launcher_safe() {
  local name="$1" target="$LAUNCHER_DIR/$1" existing
  if [ -L "$target" ]; then
    fail "Refusing symlinked launcher path: $target"
  fi
  if [ -e "$target" ] && ! is_forge_launcher "$target"; then
    fail "Refusing to overwrite non-Forge launcher: $target"
  fi
  existing="$(command -v "$name" 2>/dev/null || true)"
  if [ -n "$existing" ] && [ "$existing" != "$target" ]; then
    fail "Refusing to shadow existing command $name at $existing"
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

configure_path() {
  local shell_name config
  case ":$PATH:" in
    *":$LAUNCHER_DIR:"*) return 0 ;;
  esac

  shell_name="$(basename "${SHELL:-}")"
  case "$shell_name" in
    zsh) config="$HOME/.zshrc" ;;
    bash) config="$HOME/.bashrc" ;;
    *)
      echo "Forge launchers installed at $LAUNCHER_DIR. Add this to your shell configuration:" >&2
      printf '%s\n%s\n%s\n' "$PATH_BLOCK_START" "$PATH_BLOCK_LINE" "$PATH_BLOCK_END" >&2
      return 0
      ;;
  esac

  if [ -e "$config" ] && managed_path_block_is_exact "$config"; then
    return 0
  fi
  if [ -e "$config" ] && { [ -L "$config" ] || [ ! -f "$config" ]; }; then
    echo "Forge did not modify unsafe shell configuration $config. Add this block manually:" >&2
    printf '%s\n%s\n%s\n' "$PATH_BLOCK_START" "$PATH_BLOCK_LINE" "$PATH_BLOCK_END" >&2
    return 0
  fi
  if [ -e "$config" ] && { grep -Fq "$PATH_BLOCK_START" "$config" || grep -Fq "$PATH_BLOCK_END" "$config"; }; then
    echo "Forge did not modify ambiguous PATH markers in $config. Add the PATH block manually if needed." >&2
    return 0
  fi
  if [ -e "$config" ] && [ ! -w "$config" ]; then
    echo "Forge cannot modify $config. Add the PATH block manually if needed." >&2
    return 0
  fi

  CONFIG_UPDATED="$config"
  {
    [ ! -s "$config" ] || printf '\n'
    printf '%s\n%s\n%s\n' "$PATH_BLOCK_START" "$PATH_BLOCK_LINE" "$PATH_BLOCK_END"
  } >> "$config"
  echo "Added Forge launcher PATH block to $config"
}

write_launcher() {
  local name="$1" trace="$2" target="$LAUNCHER_DIR/$1" temporary
  temporary="$(mktemp "$LAUNCHER_DIR/.${name}.XXXXXX")"
  if [ "$trace" = 1 ]; then
    cat > "$temporary" <<'EOF'
#!/usr/bin/env bash
# Managed by Forge for Pi
exec env -u FORGEJEV -u FORGEJEV_TRACE -u FORGEJEV_JEV_ROUTING -u FORGEAPIS -u FORGEAPIS_TRACE -u FORGEAPIS_JEV_ROUTING FORGE_FOR_PI=1 FORGE_FOR_PI_TRACE=1 pi --no-extensions --extension "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions/forge-for-pi/index.ts" --no-skills "$@"
EOF
  else
    cat > "$temporary" <<'EOF'
#!/usr/bin/env bash
# Managed by Forge for Pi
exec env -u FORGEJEV -u FORGEJEV_TRACE -u FORGEJEV_JEV_ROUTING -u FORGEAPIS -u FORGEAPIS_TRACE -u FORGEAPIS_JEV_ROUTING FORGE_FOR_PI=1 pi --no-extensions --extension "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions/forge-for-pi/index.ts" --no-skills "$@"
EOF
  fi
  chmod 755 "$temporary"
  mv -f "$temporary" "$target"
}

for path in "$SOURCE_DIR" "$TARGET_DIR" "$BACKUP_DIR"; do assert_safe_tree "$path" || fail 'Unsafe source or destination.'; done
assert_safe_path "$LAUNCHER_DIR" || fail 'Unsafe launcher directory.'
[ ! -e "$TARGET_DIR" ] || [ -d "$TARGET_DIR" ] || fail 'Installation path is not a directory.'
check_pi "$SOURCE_DIR/index.ts" || fail 'Pi functional compatibility checks failed.'
[ -f "$SOURCE_DIR/index.ts" ] || fail "Release source is incomplete: $SOURCE_DIR/index.ts is missing."
if find "$SOURCE_DIR" -type l -print -quit | grep -q .; then
  fail "Release source must not contain symlinks."
fi

# Validate all user-local launcher destinations before changing the installation.
mkdir -p "$LAUNCHER_DIR"
assert_launcher_safe Forge
assert_launcher_safe Forgetrace

mkdir -p "$EXTENSIONS_DIR" "$BACKUP_DIR"
CHECKPOINT="$(mktemp -d "$BACKUP_DIR/checkpoint.XXXXXX")"
for name in Forge Forgetrace; do
  if [ -e "$LAUNCHER_DIR/$name" ]; then cp -p "$LAUNCHER_DIR/$name" "$CHECKPOINT/$name"; fi
done
for name in .bashrc .zshrc; do
  if [ -f "$HOME/$name" ] && [ ! -L "$HOME/$name" ]; then cp -p "$HOME/$name" "$CHECKPOINT/$name"; fi
done
BACKUP_PATH=""
CONFIG_UPDATED=""
INSTALL_STARTED=0
rollback() {
  local status=$? name
  [ "$status" -ne 0 ] || return 0
  trap - EXIT
  set +e
  local failed=0
  if [ "$INSTALL_STARTED" -eq 1 ]; then
    if [ -e "$TARGET_DIR" ]; then mv "$TARGET_DIR" "$CHECKPOINT/failed-installation" || failed=1; fi
    if [ -n "$BACKUP_PATH" ]; then cp -Rp "$BACKUP_PATH" "$TARGET_DIR" || failed=1; fi
    for name in Forge Forgetrace; do
      if [ -e "$CHECKPOINT/$name" ]; then cp -p "$CHECKPOINT/$name" "$LAUNCHER_DIR/$name" || failed=1;
      elif [ -e "$LAUNCHER_DIR/$name" ]; then mv "$LAUNCHER_DIR/$name" "$CHECKPOINT/new-$name" || failed=1; fi
    done
  fi
  if [ -n "$CONFIG_UPDATED" ]; then
    name="$(basename "$CONFIG_UPDATED")"
    if [ -e "$CHECKPOINT/$name" ]; then cp -p "$CHECKPOINT/$name" "$CONFIG_UPDATED" || failed=1;
    elif [ -e "$CONFIG_UPDATED" ]; then mv "$CONFIG_UPDATED" "$CHECKPOINT/new-$name" || failed=1; fi
  fi
  echo "FAIL: rollback checkpoint retained: $CHECKPOINT (restore errors: $failed)" >&2
  exit "$status"
}
trap rollback EXIT
if [ -e "$TARGET_DIR" ]; then
  BACKUP_PATH="$CHECKPOINT/previous-installation"
  mv "$TARGET_DIR" "$BACKUP_PATH"
fi
INSTALL_STARTED=1
cp -R "$SOURCE_DIR" "$TARGET_DIR"
assert_safe_tree "$TARGET_DIR" || fail 'Installation rejected symlinked content.'
write_launcher Forge 0
write_launcher Forgetrace 1
bash "$SCRIPT_DIR/verify-install.sh"
configure_path
trap - EXIT

echo "Installed Forge for Pi $VERSION to $TARGET_DIR"
echo "Use: Forge"
echo "Optional local telemetry: Forgetrace"
