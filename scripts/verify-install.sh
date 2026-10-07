#!/usr/bin/env bash
set -euo pipefail

EXPECTED_PI_VERSION="1.0.4"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
SOURCE_DIR="$SCRIPT_DIR/../src/forge-for-pi"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
TARGET_DIR="$AGENT_DIR/extensions/forge-for-pi"
LAUNCHER_DIR="$HOME/.local/bin"
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

for launcher in Forge Forgetrace; do
  path="$LAUNCHER_DIR/$launcher"
  [ -x "$path" ] && [ ! -L "$path" ] || { echo "FAIL: $launcher launcher is missing or unsafe" >&2; exit 1; }
  grep -Fqx '# Managed by Forge for Pi' "$path" || { echo "FAIL: $launcher is not Forge-managed" >&2; exit 1; }
done
grep -Fqx 'exec env -u FORGEJEV -u FORGEJEV_TRACE -u FORGEJEV_JEV_ROUTING -u FORGEAPIS -u FORGEAPIS_TRACE -u FORGEAPIS_JEV_ROUTING FORGE_FOR_PI=1 pi --no-extensions --extension "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions/forge-for-pi/index.ts" --no-skills "$@"' "$LAUNCHER_DIR/Forge" || { echo "FAIL: Forge launcher command is incorrect" >&2; exit 1; }
grep -Fqx 'exec env -u FORGEJEV -u FORGEJEV_TRACE -u FORGEJEV_JEV_ROUTING -u FORGEAPIS -u FORGEAPIS_TRACE -u FORGEAPIS_JEV_ROUTING FORGE_FOR_PI=1 FORGE_FOR_PI_TRACE=1 pi --no-extensions --extension "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions/forge-for-pi/index.ts" --no-skills "$@"' "$LAUNCHER_DIR/Forgetrace" || { echo "FAIL: Forgetrace launcher command is incorrect" >&2; exit 1; }
[ "$("$LAUNCHER_DIR/Forge" --version 2>/dev/null | tr -d '[:space:]')" = "$EXPECTED_PI_VERSION" ] || { echo "FAIL: Forge launcher does not start Pi" >&2; exit 1; }
[ "$("$LAUNCHER_DIR/Forgetrace" --version 2>/dev/null | tr -d '[:space:]')" = "$EXPECTED_PI_VERSION" ] || { echo "FAIL: Forgetrace launcher does not start Pi" >&2; exit 1; }

diff -qr "$SOURCE_DIR" "$TARGET_DIR" || { echo "FAIL: installed Forge differs from source" >&2; exit 1; }

# This checks executable availability only; runtime isolation is qualified by
# test/run-pi-runtime-validation.mjs without sending a model prompt.
FORGE_FOR_PI=0 pi --version >/dev/null
printf 'PASS: Pi %s; Forge launchers and regular install are valid; vanilla executable available.\n' "$EXPECTED_PI_VERSION"
