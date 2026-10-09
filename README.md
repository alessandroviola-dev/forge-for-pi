# Forge for Pi

Same four tools. Better engineering underneath.

**Vanilla Pi:** `read` / `bash` / `edit` / `write`  
**Forge for Pi:** `read` / `bash` / `edit` / `write`

Forge adds host-side safeguards and observability invisibly to the model. It adds no tools, skills, commands, system-prompt text, or model-facing messages.

## Daily use

```sh
# Vanilla
pi

# Forge
Forge

# Forge with optional local telemetry
Forgetrace
```

The installer creates the user-local `Forge` and `Forgetrace` launchers in `~/.local/bin` and adds its clearly marked PATH block only when needed. `Forge` is the standard launcher; `Forgetrace` additionally enables local metadata-only telemetry. Plain `pi` remains vanilla.

The managed launchers load only Forge's entrypoint with `--no-extensions --extension`, disabling automatic user/project/package and built-in extension discovery for that invocation. They remove inherited `FORGEJEV`, `FORGEJEV_TRACE`, `FORGEJEV_JEV_ROUTING`, `FORGEAPIS`, `FORGEAPIS_TRACE`, and `FORGEAPIS_JEV_ROUTING`. Forge tracing/snapshot options and the project cwd are preserved. Additional extensions require an explicit caller-supplied `--extension`; the base-only guarantee applies without such an intentional override.

For advanced/manual use, Forge remains opt-in:

```sh
FORGE_FOR_PI=1 pi --no-extensions --extension "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions/forge-for-pi/index.ts" --no-skills
```

Plain `pi` is unchanged and does not activate these products in a clean environment. Explicit activation variables are still manual opt-ins; do not export them globally.

## Components

- **Smart Read** returns a compact structural view for eligible large source files; exact ranges remain available through `read`.
- **Safe Snapshot Edit** provides scoped snapshots, seen-range validation, stale protection, a no-op guard, and atomic edits.
- **Reactive Diagnostics** appends newly introduced local diagnostics after writes without adding a tool.
- **Context Intelligence** conservatively packs large prior tool evidence host-side when it materially saves context.
- **Task Progress Monitor** renders the observed lifecycle state **Understand → Work → Finalize** plus Pi-reported measured average output speed (`avg 41 tok/s`) when final usage is available. It never displays counters, percentages, ETA, checks, or recovery details. Reads and inspection remain in Understand; a direct `edit` or `write` request moves the UI to Work.
- **Optional Telemetry** writes local metadata-only measurements only when `FORGE_FOR_PI_TRACE=1`.

Task Progress Monitor is host/TUI-only and has zero model-facing token overhead. Its single-row state display is intentionally not a claim of measured or semantic task completion.

## Install

Installation uses functional compatibility checks, not a Pi version allowlist. Pi must provide a working CLI, `--no-extensions`, `--extension`, `--no-skills`, compatible extension registration and Forge's tool/UI lifecycle APIs. Versions are accepted only when these offline checks pass; this is not a guarantee of compatibility with every future Pi release.

```sh
./scripts/install.sh
./scripts/verify-install.sh
```

The installer copies the extension to `~/.pi/agent/extensions/forge-for-pi/`, creates Forge-managed launchers in `~/.local/bin`, and retains previous extensions, launchers and shell configuration in checkpoints outside extension discovery. It verifies the replacement before completion; failures restore previous artifacts and retain failed output. A filesystem error during rollback requires manual recovery from the retained checkpoint. Symlinked paths/content and unmanaged or shadowed launchers are rejected. It does not touch `auth.json`, `models.json`, skills or sibling installs. Only Forge's managed shell PATH block may be added when needed.

The capability probe loads an isolated synthetic lifecycle handler and the Forge factory without dispatching Forge's production handlers, creating a session, reading credentials or calling models. Pi 1.0.4, 1.1.0 and a future version are covered by deterministic simulations; real Pi 1.1.0 startup, installer/verifier and isolation have been verified in sandbox. This qualifies the checked-out source, not a replacement of the historical v1.0.2 release archive or the existing installed Forge.

To remove Forge, its managed launchers, and only its managed PATH block:

```sh
./scripts/uninstall.sh
```

## Verified benchmarks

These are measured results, not global claims:

| Area | Verified result |
| --- | --- |
| Smart Read | **-25.90% input tokens**, **-39.14% returned bytes** in the specific Smart Read benchmark |
| Snapshot Edit 3B | about **+1.0% token overhead** vs vanilla; **2/2** real stale edits blocked; **1** false stale avoided |
| Reactive Diagnostics | **1/1** introduced Python error detected and corrected; **0** false positives in available tests |
| Task Progress Monitor | unit/regression tests PASS; deterministic validation PASS; manual renderer validation PASS; **0** model-facing token overhead |

The -25.90% figure applies only to the specific Smart Read benchmark. It does **not** claim a reduction for every Forge task. A legacy engineering benchmark is not used for global Forge claims.

## Limits

- Reactive Diagnostics v1.0.0 is primarily Python/Ruff.
- Task Progress Monitor relies on observable lifecycle evidence and cannot semantically prove absolute task completion.
- Functional checks can demonstrate incompatibilities but cannot prove every future Pi behavior. Historical Pi 0.84.4 renderer evidence remains in `docs/MANUAL_VALIDATION.md`; no new manual TUI or live model validation is claimed.
- Forge for Pi is independent and is not affiliated with or approved by Pi's maintainers.

See `docs/` for architecture, design principles, and benchmark scope.
