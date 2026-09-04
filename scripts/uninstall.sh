#!/usr/bin/env bash
set -euo pipefail

AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
TARGET_DIR="$AGENT_DIR/extensions/forge-for-pi"

if [ -e "$TARGET_DIR" ] || [ -L "$TARGET_DIR" ]; then
  rm -rf "$TARGET_DIR"
  echo "Removed Forge for Pi from $TARGET_DIR"
else
  echo "Forge for Pi is not installed at $TARGET_DIR"
fi
