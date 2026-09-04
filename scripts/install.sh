#!/usr/bin/env bash
set -euo pipefail

EXPECTED_PI_VERSION="0.84.4"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
SOURCE_DIR="$(CDPATH= cd -- "$SCRIPT_DIR/../src/forge-for-pi" && pwd)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
EXTENSIONS_DIR="$AGENT_DIR/extensions"
TARGET_DIR="$EXTENSIONS_DIR/forge-for-pi"
BACKUP_DIR="$AGENT_DIR/forge-for-pi-backups"

if ! command -v pi >/dev/null 2>&1; then
  echo "Forge for Pi requires pi on PATH." >&2
  exit 1
fi

PI_VERSION="$(pi --version 2>/dev/null | tr -d '[:space:]')"
if [ "$PI_VERSION" != "$EXPECTED_PI_VERSION" ]; then
  echo "Forge for Pi 1.0.0 is verified for Pi $EXPECTED_PI_VERSION; found ${PI_VERSION:-unknown}." >&2
  exit 1
fi

[ -f "$SOURCE_DIR/index.ts" ] || { echo "Release source is incomplete: $SOURCE_DIR/index.ts is missing." >&2; exit 1; }
if find "$SOURCE_DIR" -type l -print -quit | grep -q .; then
  echo "Release source must not contain symlinks." >&2
  exit 1
fi

mkdir -p "$EXTENSIONS_DIR"
if [ -e "$TARGET_DIR" ] || [ -L "$TARGET_DIR" ]; then
  mkdir -p "$BACKUP_DIR"
  BACKUP_PATH="$BACKUP_DIR/forge-for-pi-$(date -u +%Y%m%dT%H%M%SZ)"
  if [ -e "$BACKUP_PATH" ]; then
    BACKUP_PATH="${BACKUP_PATH}-$$"
  fi
  mv "$TARGET_DIR" "$BACKUP_PATH"
  echo "Backed up existing Forge installation to $BACKUP_PATH"
fi

# Copy, never link: the installed extension remains valid after this release
# directory is moved or removed.
cp -R "$SOURCE_DIR" "$TARGET_DIR"
find "$TARGET_DIR" -type l -print -quit | grep -q . && { rm -rf "$TARGET_DIR"; echo "Installation rejected symlinked content." >&2; exit 1; }

echo "Installed Forge for Pi 1.0.0 to $TARGET_DIR"
echo "Use: FORGE_FOR_PI=1 pi --no-skills"
