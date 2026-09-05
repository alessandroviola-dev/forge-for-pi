# Task Progress Monitor Manual Validation — 1.0.2

Validation target: the host/TUI renderer on Pi 0.84.4.

| Scenario | Manual event sequence | Expected visible row | Result |
| --- | --- | --- | --- |
| Initial inspection | Begin task; start/end `read` (and optionally an inspection `bash`) | `▶ Understand | ○ Work | ○ Finalize` | PASS |
| Operational work | After inspection, start `edit` or `write` | `✓ Understand | ▶ Work | ○ Finalize` | PASS |
| Finalization | Trigger `agent_end` after Work | `✓ Understand | ✓ Work | ▶ Finalize` | PASS |
| Settled task | Trigger `agent_settled` | `✓ Understand | ✓ Work | ✓ Finalize` | PASS |
| Finalized model output | `turn_start.timestamp=1000`; assistant `message_end` at 3000 with `usage.output=82` | `▶ Understand | ○ Work | ○ Finalize | avg 41 tok/s` | PASS |
| Missing/zero usage | Finalize an assistant message with no usage, `output=0`, or zero duration | `… | tok/s …` (never `NaN`/`Infinity`) | PASS |
| Tool between generations | Complete a measured assistant message; run `bash`; begin the next `turn_start` | Keeps the completed rate during the tool, then `tok/s …` for the new turn | PASS |
| Hidden metadata | Run a failing verification command during Work | Still the Work row only; no counter, percentage, ETA, Checks, or Recovery text | PASS |
| Short task | Complete before the 2.5 s reveal threshold | No persistent widget | PASS |

The renderer was manually inspected through the monitor lifecycle calls and checked at narrow and normal widths. The same paths are covered by `test/task-progress-monitor.test.mjs` and `test/run-task-progress-validation.mjs`.

**Manual validation: PASS.**
