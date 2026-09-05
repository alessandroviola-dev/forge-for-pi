import { MilestoneState, TaskProgressMonitor, TaskState } from "../src/forge-for-pi/task-progress-monitor-core.mjs";

const UI = Object.freeze({
	understand: "▶ Understand | ○ Work | ○ Finalize",
	work: "✓ Understand | ▶ Work | ○ Finalize",
	finalize: "✓ Understand | ✓ Work | ▶ Finalize",
	done: "✓ Understand | ✓ Work | ✓ Finalize",
});

function run({ name, prompt, events }) {
	const monitor = new TaskProgressMonitor({ minVisibleMs: 0 });
	monitor.begin(prompt);
	const observedRows = [];
	for (const [index, event] of events.entries()) {
		const id = `event-${index}`;
		monitor.toolStart(event.tool, event.args ?? {}, undefined, id);
		observedRows.push(monitor.render(120)?.[0]);
		monitor.toolEnd(event.tool, event.args ?? {}, !!event.error, undefined, id);
	}
	monitor.agentEnd();
	const finalizeRow = monitor.render(120)?.[0];
	monitor.settle();
	const snapshot = monitor.snapshot();
	return {
		name,
		state: snapshot.state,
		allDone: snapshot.milestones.every((item) => item.state === MilestoneState.DONE),
		initialReadRow: observedRows[0],
		workRow: observedRows.find((row) => row === UI.work),
		finalizeRow,
		finalRow: monitor.render(120)?.[0],
		rowCount: monitor.render(120)?.length,
		noRemovedUI: observedRows.filter(Boolean).every((row) => !/(?:Checks|Recovery|\d\/3|%|ETA)/.test(row)),
	};
}

const rows = [
	run({ name: "feature", prompt: "Add a deterministic greeting feature", events: [{ tool: "read" }, { tool: "write" }, { tool: "bash", args: { command: "npm test" } }] }),
	run({ name: "edit-test-edit-test", prompt: "Fix deterministic login bug", events: [{ tool: "read" }, { tool: "edit" }, { tool: "bash", args: { command: "pytest" } }, { tool: "edit" }, { tool: "bash", args: { command: "pytest" } }] }),
	run({ name: "failed-test-recovery", prompt: "Add deterministic validation", events: [{ tool: "read" }, { tool: "edit" }, { tool: "bash", args: { command: "npm test" }, error: true }, { tool: "edit" }, { tool: "bash", args: { command: "npm test" } }] }),
	run({ name: "no-check", prompt: "Refactor deterministic parser", events: [{ tool: "read" }, { tool: "edit" }] }),
];

console.log(JSON.stringify(rows, null, 2));
if (rows.some((row) => row.state !== TaskState.DONE || !row.allDone || row.initialReadRow !== UI.understand || !row.workRow || row.finalizeRow !== UI.finalize || row.finalRow !== UI.done || row.rowCount !== 1 || !row.noRemovedUI)) process.exitCode = 1;
