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
FORGE_FOR_PI=1 pi --no-skills

# Forge with optional local telemetry
FORGE_FOR_PI=1 FORGE_FOR_PI_TRACE=1 pi --no-skills
```

`FORGE_FOR_PI` is opt-in. Without it, Forge's extension entrypoint makes no registrations, so plain `pi` remains vanilla.

## Components

- **Smart Read** returns a compact structural view for eligible large source files; exact ranges remain available through `read`.
- **Safe Snapshot Edit** provides scoped snapshots, seen-range validation, stale protection, a no-op guard, and atomic edits.
- **Reactive Diagnostics** appends newly introduced local diagnostics after writes without adding a tool.
- **Context Intelligence** conservatively packs large prior tool evidence host-side when it materially saves context.
- **Task Progress Monitor** renders real observed task progress: **Understand → Work → Verify → Finalize**. Verify is never marked DONE without successful verification evidence for the current change.
- **Optional Telemetry** writes local metadata-only measurements only when `FORGE_FOR_PI_TRACE=1`.

Task Progress Monitor is host/TUI-only and has zero model-facing token overhead. It uses observable lifecycle evidence; it does not claim semantic proof of absolute task completeness.

## Install

Forge is verified with Pi 0.84.4.

```sh
./scripts/install.sh
./scripts/verify-install.sh
```

The installer copies the extension to `~/.pi/agent/extensions/forge-for-pi/`, backs up a previous Forge installation outside extension discovery, and does not touch `auth.json`, `models.json`, skills, or unrelated user configuration. It is safe to run again.

To remove only the installed Forge extension:

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
| Task Progress Monitor | unit/regression tests PASS; deterministic validation PASS; manual TUI validation PASS; **0** model-facing token overhead |

The -25.90% figure applies only to the specific Smart Read benchmark. It does **not** claim a reduction for every Forge task. A legacy engineering benchmark is not used for global Forge claims.

## Limits

- Reactive Diagnostics v1.0.0 is primarily Python/Ruff.
- Task Progress Monitor relies on observable evidence and cannot semantically prove absolute task completion.
- Forge is verified on Pi 0.84.4.
- Forge for Pi is independent and is not affiliated with or approved by Pi's maintainers.

See `docs/` for architecture, design principles, and benchmark scope.
