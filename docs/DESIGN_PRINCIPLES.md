# Design Principles

1. **Four tools only.** The model sees only `read`, `bash`, `edit`, and `write`.
2. **Opt-in and reversible.** `FORGE_FOR_PI=1` activates Forge; plain `pi` remains vanilla.
3. **Evidence over assertion.** The widget reports only observed lifecycle state, never a completion metric; host-side verification evidence never asserts semantic task completion or appears in the widget.
4. **Fail open.** Unsupported files, unavailable diagnostics, and host processing errors preserve native Pi behavior.
5. **Scoped safety.** Snapshot validation protects observed edit targets rather than unrelated bytes.
6. **No hidden prompting.** Forge adds no skill, model-facing system prompt, tool, or message.
7. **Local and optional telemetry.** Telemetry is off by default and stores metadata, not tool content.
8. **Public hygiene.** Releases exclude personal paths, backups, private traces, temporary fixtures, and legacy public naming.
