#!/usr/bin/env bash
set -euo pipefail

EXPECTED_PI_VERSION="0.84.4"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
TARGET_DIR="$AGENT_DIR/extensions/forge-for-pi"
REQUIRED=(
  index.ts forge-runtime.mjs smart-read.ts smart-read-core.mjs
  snapshot-edit-lite.ts snapshot-edit-lite-core.mjs
  reactive-diagnostics.ts reactive-diagnostics-core.mjs
  forge-context-intelligence.ts forge-context-intelligence-core.mjs
  task-progress-monitor.ts task-progress-monitor-core.mjs forge-telemetry.ts
)

command -v pi >/dev/null 2>&1 || { echo "FAIL: pi is not installed" >&2; exit 1; }
[ "$(pi --version 2>/dev/null | tr -d '[:space:]')" = "$EXPECTED_PI_VERSION" ] || { echo "FAIL: Pi $EXPECTED_PI_VERSION is required" >&2; exit 1; }
[ -d "$TARGET_DIR" ] && [ ! -L "$TARGET_DIR" ] || { echo "FAIL: Forge installation is missing or symlinked" >&2; exit 1; }
for file in "${REQUIRED[@]}"; do
  [ -f "$TARGET_DIR/$file" ] || { echo "FAIL: missing $file" >&2; exit 1; }
done
if find "$TARGET_DIR" -type l -print -quit | grep -q .; then
  echo "FAIL: installed Forge contains a symlink" >&2
  exit 1
fi
grep -q 'FORGE_FOR_PI' "$TARGET_DIR/forge-runtime.mjs" || { echo "FAIL: Forge opt-in gate missing" >&2; exit 1; }
if find "$TARGET_DIR" -iname '*process*monitor*' -print -quit | grep -q .; then
  echo "FAIL: excluded component found" >&2
  exit 1
fi

# This checks that the vanilla executable remains available without enabling Forge.
FORGE_FOR_PI=0 pi --version >/dev/null
printf 'PASS: Pi %s; regular Forge install at %s; vanilla executable available.\n' "$EXPECTED_PI_VERSION" "$TARGET_DIR"
