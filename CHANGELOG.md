# Changelog

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
