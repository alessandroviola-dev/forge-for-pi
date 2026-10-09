#!/usr/bin/env bash
# Shared pre-mutation checks; no numerical version allowlist.
assert_safe_path() {
  local path="$1"
  while [ "$path" != / ] && [ -n "$path" ]; do
    [ ! -L "$path" ] || { echo 'FAIL: unsafe symlink path' >&2; return 1; }
    path="$(dirname "$path")"
  done
}
assert_safe_tree() {
  assert_safe_path "$1" || return 1
  if [ -d "$1" ] && find "$1" -type l -print -quit | grep -q .; then
    echo 'FAIL: symlinked artifact content' >&2; return 1
  fi
}
check_pi() {
  command -v pi >/dev/null 2>&1 || { echo 'FAIL: Pi CLI missing' >&2; return 1; }
  PI_VERSION="$(PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 pi --version 2>/dev/null)" || return 1
  PI_VERSION="$(printf '%s' "$PI_VERSION" | tr -d '[:space:]')"
  [ -n "$PI_VERSION" ] || { echo 'FAIL: Pi CLI nonfunctional' >&2; return 1; }
  local help option
  help="$(PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 pi --help 2>/dev/null)" || return 1
  for option in --no-extensions --extension --no-skills; do
    printf '%s\n' "$help" | grep -Eq -- "${option}([[:space:],=]|$)" || { echo "FAIL: Pi missing CLI flag $option" >&2; return 1; }
  done
  PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 node "$SCRIPT_DIR/check-pi-capabilities.mjs" "$(command -v pi)" "$1"
}
