# Architecture

`src/forge-for-pi/index.ts` is the sole extension entrypoint, installed at `~/.pi/agent/extensions/forge-for-pi/index.ts` (or the corresponding `PI_CODING_AGENT_DIR`). On the current Pi 1.0.4 target, `Forge` and `Forgetrace` pass `--no-extensions --extension` with that exact entrypoint. Automatic extension discovery, including sibling products and built-in extensions, is disabled for these launchers. One Forge copy is loaded; no Jev/API module is imported by Forge.

Both launchers unset `FORGEJEV`, `FORGEJEV_TRACE`, `FORGEJEV_JEV_ROUTING`, `FORGEAPIS`, `FORGEAPIS_TRACE`, and `FORGEAPIS_JEV_ROUTING`, then activate `FORGE_FOR_PI=1`. `Forgetrace` additionally sets `FORGE_FOR_PI_TRACE=1`. Other Forge options and the user's cwd/arguments are preserved. Caller-supplied explicit extension paths remain intentional overrides, not automatic composition. Plain `pi` and its resource discovery/configuration are unchanged.

When `FORGE_FOR_PI` is not `1`, the entrypoint returns before registering behavior. When enabled, it keeps Pi's active model-facing tools exactly `read`, `bash`, `edit`, and `write`.

The components either replace the implementation of an existing built-in slot (`read`, `edit`) or observe host lifecycle events. None registers a new tool, skill, command, prompt template, or system prompt. The component claim guard prevents duplicate registration.

Task Progress Monitor is a one-row TUI widget. It renders the current Understand → Work → Finalize state: reads and inspection leave Understand active, while a direct `edit` or `write` request activates Work. Its lifecycle handlers return no model-context patch.

On the current Pi 1.0.4 target, `turn_start.timestamp` is the model-turn start and `message_end` supplies the finalized assistant message. The monitor uses only `message.usage.output`, captured at assistant `message_end`, divided by `(message_end host time - turn_start.timestamp) / 1000`. It never reads `input`, `cacheRead`, or `cacheWrite`; ending at `message_end` excludes subsequent `tool_execution_*` time. Pi exposes streaming `message_update` events and text/thinking/tool-call deltas, but no documented incrementally updated output-token count, so live tok/s is intentionally unavailable. A pending or unavailable measurement renders `tok/s …`; the completed turn renders its rounded measured average as `avg 41 tok/s`. Telemetry is disabled unless `FORGE_FOR_PI_TRACE=1` and records metadata locally.

This release performs no process sampling, CPU/RAM collection, or process-listing.

Local qualification commands:

```sh
node --test test/*.test.mjs
node test/run-task-progress-validation.mjs
node test/run-pi-runtime-validation.mjs --source  # generated launchers, before install
bash scripts/install.sh
bash scripts/verify-install.sh
node test/run-pi-runtime-validation.mjs           # installed launchers
shasum -a 256 -c MANIFEST.sha256
```

The runtime gate starts fresh real Pi RPC processes offline, sends only `get_state`, and observes Pi's own resource loader. It requires one Forge entrypoint with exactly the `read`/`edit` replacements and no sibling extension loaded, tests inherited sibling activation variables, and checks plain Pi's product factories remain inactive in a clean environment. It makes no model calls and prints no credentials. Plain Pi is tested with Forge-family activation variables explicitly removed and must still resolve to the real Pi package. Raw Pi with deliberate sibling opt-ins is outside Forge's launcher-isolation contract: Forge neither intercepts that process nor sanitizes its environment. Forge never installs these variables globally or changes Pi configuration. The original manual renderer evidence on Pi 0.84.4 is retained separately.
