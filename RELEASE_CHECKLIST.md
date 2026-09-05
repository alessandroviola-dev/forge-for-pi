# Release Checklist — 1.0.2

- [x] Public name: Forge for Pi
- [x] Version file: 1.0.2
- [x] Only model-facing tools: read, bash, edit, write
- [x] Task Progress Monitor lifecycle: Understand → Work → Finalize
- [x] Task Progress Monitor renders one row only, with no counter, percentage, ETA, Checks, or Recovery text
- [x] Token speed is final-turn average only (`avg N tok/s` from Pi `usage.output`); no live estimate, tokenizer, or character/byte conversion
- [x] Understand remains active for reads and inspection; a direct `edit` or `write` request activates Work
- [x] Short-task suppression retained
- [x] Smart Read, Snapshot Edit, Diagnostics, Context Intelligence, launchers, and telemetry unchanged
- [x] Official `Forge` and telemetry `Forgetrace` launchers included
- [x] Idempotent user-local PATH handling and safe uninstall included
- [x] Installer target: `~/.pi/agent/extensions/forge-for-pi/`
- [x] Pi 0.84.4 compatibility gate
- [x] No auth, models, skills, or unrelated user-configuration changes
- [x] Full unit/regression suite and deterministic validation passed
- [x] Manual renderer validation passed; procedure recorded in `docs/MANUAL_VALIDATION.md`
- [x] Privacy, secret, path, and legacy-name scans passed
- [x] SHA-256 manifest regenerated and verified
- [x] Release archive regenerated, extracted, and verified

Residual limits are documented in `README.md`.
