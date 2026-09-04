import { CheckState, MilestoneState, TaskProgressMonitor, TaskState } from "../src/forge-for-pi/task-progress-monitor-core.mjs";

function run({ name, prompt, events }) {
	const monitor = new TaskProgressMonitor({ minVisibleMs: 0 });
	monitor.begin(prompt);
	const denominators = [];
	for (const [index, event] of events.entries()) {
		const id = `event-${index}`;
		monitor.toolStart(event.tool, event.args ?? {}, undefined, id);
		monitor.toolEnd(event.tool, event.args ?? {}, !!event.error, undefined, id);
		monitor.render();
		denominators.push(monitor.snapshot().progress.total);
	}
	monitor.agentEnd();
	monitor.settle();
	const snapshot = monitor.snapshot();
	const rows = monitor.render(120) ?? [];
	return {
		name,
		progress: snapshot.progress,
		state: snapshot.state,
		checks: snapshot.checks,
		allDone: snapshot.milestones.every((item) => item.state === MilestoneState.DONE),
		stableDenominator: denominators.every((total) => total === 3),
		activeCount: snapshot.milestones.filter((item) => item.state === MilestoneState.ACTIVE).length,
		rows,
		noVerifyMilestone: !snapshot.milestones.some((item) => item.label === "Verify"),
	};
}

const rows = [
	run({ name: "feature", prompt: "Add a deterministic greeting feature", events: [{ tool: "read" }, { tool: "write" }, { tool: "bash", args: { command: "npm test" } }] }),
	run({ name: "edit-test-edit-test", prompt: "Fix deterministic login bug", events: [{ tool: "read" }, { tool: "edit" }, { tool: "bash", args: { command: "pytest" } }, { tool: "edit" }, { tool: "bash", args: { command: "pytest" } }] }),
	run({ name: "failed-test-recovery", prompt: "Add deterministic validation", events: [{ tool: "read" }, { tool: "edit" }, { tool: "bash", args: { command: "npm test" }, error: true }, { tool: "edit" }, { tool: "bash", args: { command: "npm test" } }] }),
	run({ name: "no-check", prompt: "Refactor deterministic parser", events: [{ tool: "read" }, { tool: "edit" }] }),
];

console.log(JSON.stringify(rows, null, 2));
if (rows.some((row) => row.state !== TaskState.DONE || !row.allDone || row.progress.done !== 3 || row.progress.total !== 3 || row.progress.percent !== 100 || !row.stableDenominator || row.activeCount !== 0 || !row.noVerifyMilestone)) process.exitCode = 1;
if (rows.find((row) => row.name === "no-check")?.checks !== CheckState.NOT_OBSERVED) process.exitCode = 1;
if (rows.filter((row) => row.name !== "no-check").some((row) => row.checks !== CheckState.PASS)) process.exitCode = 1;
