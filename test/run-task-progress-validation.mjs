import { TaskProgressMonitor, MilestoneState, TaskState } from "../src/forge-for-pi/task-progress-monitor-core.mjs";

function run({ name, prompt, events }) {
	const monitor = new TaskProgressMonitor({ minVisibleMs: 0 });
	monitor.begin(prompt);
	const denominators = [];
	for (const event of events) {
		monitor.toolStart(event.tool, event.args ?? {});
		monitor.toolEnd(event.tool, event.args ?? {}, !!event.error);
		// Mirror the adapter's live redraw before the terminal visibility gate.
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
		allDone: snapshot.milestones.every((item) => item.state === MilestoneState.DONE),
		stableDenominator: denominators.every((total) => total === 4),
		activeCount: snapshot.milestones.filter((item) => item.state === MilestoneState.ACTIVE).length,
		rows,
		noLegacyPlan: !rows.join("\n").match(/Recovery.*\||plan refined|\/5|widget truncated/),
	};
}

const rows = [
	run({ name: "feature", prompt: "Add a deterministic greeting feature", events: [{ tool: "read" }, { tool: "write" }, { tool: "bash", args: { command: "npm test" } }] }),
	run({ name: "bugfix", prompt: "Fix deterministic login bug", events: [{ tool: "read" }, { tool: "edit" }, { tool: "bash", args: { command: "pytest" } }] }),
	run({ name: "refactor", prompt: "Refactor deterministic parser", events: [{ tool: "read" }, { tool: "edit" }, { tool: "bash", args: { command: "npm run lint" } }] }),
	run({ name: "failed-test-recovery", prompt: "Add deterministic validation", events: [{ tool: "read" }, { tool: "edit" }, { tool: "bash", args: { command: "npm test" }, error: true }, { tool: "edit" }, { tool: "bash", args: { command: "npm test" } }] }),
];

console.log(JSON.stringify(rows, null, 2));
if (rows.some((row) => row.state !== TaskState.DONE || !row.allDone || row.progress.done !== 4 || row.progress.total !== 4 || row.progress.percent !== 100 || !row.stableDenominator || row.activeCount !== 0 || !row.noLegacyPlan)) process.exitCode = 1;
