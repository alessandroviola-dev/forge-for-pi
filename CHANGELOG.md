# Changelog

## Unreleased

- Target current installation/verification at exactly Pi 1.0.4; retain original Pi 0.84.4 release/manual evidence.
- Make Forge/Forgetrace base-only: unset sibling activation/trace/routing variables, disable automatic extension discovery and explicitly load one Forge entrypoint.
- Add clean/contaminated launcher tests, offline real-Pi startup isolation qualification, and verifier source/install parity.

## 1.0.2

- Replaced the Task Progress Monitor metric display with one minimal lifecycle row: **Understand → Work → Finalize**.
- Added host-side average output speed from final Pi assistant `usage.output` and model-turn timing; unavailable turns render `tok/s …`.
- Kept the Understand → Work → Finalize state machine unchanged and added no model-facing behavior.
- Removed progress counters, percentages, ETA, Checks, and Recovery from the widget UI.
- Kept Understand active through reads and inspection; only a direct `edit` or `write` request advances the UI to Work.
- Retained short-task suppression and host-side check/recovery observation without rendering those details.

## 1.0.1

- Added official `Forge` and telemetry-enabled `Forgetrace` launchers with argument passthrough.
- Added safe, idempotent user-local PATH handling and safe uninstall support.
- Simplified Task Progress Monitor lifecycle to **Understand → Work → Finalize**.
- Reported verification independently as Checks: `not observed`, `running`, `PASS`, or `FAIL`.
- Added short-task widget suppression.

## 1.0.0

Public Forge for Pi release.

- Four-tool host-side engineering layer: Smart Read, Safe Snapshot Edit, Reactive Diagnostics, Context Intelligence, Task Progress Monitor, and optional telemetry.
- Opt-in activation with `FORGE_FOR_PI=1`.
- Clean installer, verifier, uninstaller, release manifest, and public documentation.
- No excluded legacy component, legacy public naming, skills, extra tools, or model-facing prompt/messages.
