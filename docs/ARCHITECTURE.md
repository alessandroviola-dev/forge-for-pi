# Architecture

`src/forge-for-pi/index.ts` is the sole extension entrypoint. Pi discovers that directory's `index.ts` from `~/.pi/agent/extensions/forge-for-pi/`.

When `FORGE_FOR_PI` is not `1`, the entrypoint returns before registering behavior. When enabled, it keeps Pi's active model-facing tools exactly `read`, `bash`, `edit`, and `write`.

The components either replace the implementation of an existing built-in slot (`read`, `edit`) or observe host lifecycle events. None registers a new tool, skill, command, prompt template, or system prompt. The component claim guard prevents duplicate registration.

Task Progress Monitor is a one-row TUI widget. It renders the current Understand → Work → Finalize state: reads and inspection leave Understand active, while a direct `edit` or `write` request activates Work. Its lifecycle handlers return no model-context patch.

On Pi 0.84.4, `turn_start.timestamp` is the model-turn start and `message_end` supplies the finalized assistant message. The monitor uses only `message.usage.output`, captured at assistant `message_end`, divided by `(message_end host time - turn_start.timestamp) / 1000`. It never reads `input`, `cacheRead`, or `cacheWrite`; ending at `message_end` excludes subsequent `tool_execution_*` time. Pi exposes streaming `message_update` events and text/thinking/tool-call deltas, but no documented incrementally updated output-token count, so live tok/s is intentionally unavailable. A pending or unavailable measurement renders `tok/s …`; the completed turn renders its rounded measured average as `avg 41 tok/s`. Telemetry is disabled unless `FORGE_FOR_PI_TRACE=1` and records metadata locally.

This release performs no process sampling, CPU/RAM collection, or process-listing.
