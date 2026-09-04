# Architecture

`src/forge-for-pi/index.ts` is the sole extension entrypoint. Pi discovers that directory's `index.ts` from `~/.pi/agent/extensions/forge-for-pi/`.

When `FORGE_FOR_PI` is not `1`, the entrypoint returns before registering behavior. When enabled, it keeps Pi's active model-facing tools exactly `read`, `bash`, `edit`, and `write`.

The components either replace the implementation of an existing built-in slot (`read`, `edit`) or observe host lifecycle events. None registers a new tool, skill, command, prompt template, or system prompt. The component claim guard prevents duplicate registration.

Task Progress Monitor is a TUI widget. Its lifecycle handlers return no model-context patch. Telemetry is disabled unless `FORGE_FOR_PI_TRACE=1` and records metadata locally.

This release performs no process sampling, CPU/RAM collection, or process-listing.
