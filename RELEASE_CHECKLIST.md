# Release Checklist

## Current main qualification — Pi 1.0.4

The current installer/verifier target is exactly Pi 1.0.4. No new release, tag, archive or manual TUI/live-model evidence is produced by this qualification.

- [ ] Full tracked unit/regression suite and deterministic task-progress validation pass locally.
- [ ] Real Pi 1.0.4 startup/extension registration passes without a model request.
- [ ] Forge/Forgetrace neutralize inherited sibling activation, trace and routing variables while preserving Forge options/cwd/arguments.
- [ ] Only the Forge base entrypoint loads in Forge/Forgetrace; no sibling or second Forge copy loads.
- [ ] Plain Pi stays unchanged and product-inactive in a clean environment.
- [ ] Shell/Node syntax and privacy/secret/path scans pass.
- [ ] Current SHA-256 manifest is regenerated and verifies, including new tests.
- [ ] Install, verify-install and installed-source parity pass on Pi 1.0.4.

## Historical release evidence — 1.0.2

The following records the original release qualification, including its Pi 0.84.4 target. It is not rewritten as new Pi 1.0.4 manual or archive evidence.

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
