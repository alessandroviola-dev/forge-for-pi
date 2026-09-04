import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { TaskProgressMonitor, classifyBashCommand, classifyTask, MilestoneState, TaskState } from "../src/forge-for-pi/task-progress-monitor-core.mjs";

function monitor(options = {}) {
	let now = 0;
	return { advance(ms) { now += ms; return now; }, subject: new TaskProgressMonitor({ now: () => now, minVisibleMs: 0, ...options }) };
}
function milestone(subject, label) { return subject.snapshot().milestones.find((item) => item.label === label); }
function start(subject, tool, args = {}) { return subject.toolStart(tool, args); }
function end(subject, tool, args = {}, error = false) { return subject.toolEnd(tool, args, error); }
function succeed(subject, tool, args = {}) { start(subject, tool, args); end(subject, tool, args); }
function settle(subject) { subject.agentEnd(); subject.settle(); }
function rows(subject, width) { return subject.render(width) ?? []; }
function activeCount(subject) { return subject.snapshot().milestones.filter((item) => item.state === MilestoneState.ACTIVE).length; }
function codingProgress(subject) { return subject.snapshot().progress; }

// The canonical coding path progresses monotonically from an empty plan to
// 4/4; reads help Understand but are never a fifth item.
test("coding task uses the immutable Understand, Work, Verify, Finalize plan from 0 to 4/4", () => {
	const { subject } = monitor();
	subject.begin("Add a small export feature");
	assert.deepEqual(codingProgress(subject), { done: 0, total: 4, percent: 0 });
	assert.deepEqual(subject.snapshot().milestones.map((item) => item.label), ["Understand", "Work", "Verify", "Finalize"]);

	start(subject, "read");
	assert.equal(milestone(subject, "Understand").state, MilestoneState.DONE);
	assert.equal(codingProgress(subject).total, 4);
	end(subject, "read");
	// Rendering while the task is live reveals the transient widget.
	rows(subject);
	start(subject, "write");
	assert.equal(milestone(subject, "Work").state, MilestoneState.ACTIVE);
	end(subject, "write");
	assert.deepEqual(codingProgress(subject), { done: 2, total: 4, percent: 50 });
	start(subject, "bash", { command: "npm test" });
	assert.equal(milestone(subject, "Verify").state, MilestoneState.ACTIVE);
	end(subject, "bash", { command: "npm test" });
	assert.deepEqual(codingProgress(subject), { done: 3, total: 4, percent: 75 });
	subject.agentEnd();
	assert.equal(milestone(subject, "Finalize").state, MilestoneState.ACTIVE);
	subject.settle();
	assert.equal(subject.snapshot().state, TaskState.DONE);
	assert.deepEqual(codingProgress(subject), { done: 4, total: 4, percent: 100 });
	assert.ok(rows(subject).includes("Forge Task  4/4  100% | ✓ Understand | ✓ Work | ✓ Verify | ✓ Finalize"));
	assert.ok(rows(subject).includes("DONE"));
});

test("explicit verification commands activate and complete Verify", () => {
	const commands = [
		"python3 -m unittest discover -s tests -v", "python -m unittest", "unittest", "pytest -q", "python -m pytest",
		"ruff check .", "mypy .", "pyright", "npm test", "npm run test", "pnpm test", "yarn test", "vitest run", "jest",
		"tsc --noEmit", "eslint .", "cargo test", "cargo check", "cargo clippy", "go test ./...", "go vet ./...",
		"make test",
	];
	for (const command of commands) {
		assert.equal(classifyBashCommand(command), "verification", command);
		const { subject } = monitor();
		subject.begin("Implement a small feature");
		succeed(subject, "edit");
		start(subject, "bash", { command });
		assert.equal(milestone(subject, "Verify").state, MilestoneState.ACTIVE, command);
		end(subject, "bash", { command });
		assert.equal(milestone(subject, "Verify").state, MilestoneState.DONE, command);
	}
});

test("failed verification enters recovery without adding a milestone, then passes", () => {
	const { subject } = monitor();
	subject.begin("Fix the login bug");
	succeed(subject, "edit");
	end(subject, "bash", { command: "pytest" }, true);
	const afterFailure = subject.snapshot();
	assert.equal(afterFailure.recoveryCount, 1);
	assert.equal(afterFailure.recoveryActive, true);
	assert.deepEqual(afterFailure.progress, { done: 2, total: 4, percent: 50 });
	assert.equal(milestone(subject, "Work").state, MilestoneState.ACTIVE);
	assert.equal(milestone(subject, "Verify").state, MilestoneState.PENDING);
	assert.ok(rows(subject).includes("Recovery #1 — correcting after failed verification"));
	assert.equal(activeCount(subject), 1);

	succeed(subject, "edit");
	succeed(subject, "bash", { command: "pytest" });
	assert.equal(milestone(subject, "Verify").state, MilestoneState.DONE);
	assert.deepEqual(codingProgress(subject), { done: 3, total: 4, percent: 75 });
});

test("consecutive recoveries keep the denominator fixed and one active milestone", () => {
	const { subject } = monitor();
	subject.begin("Implement a feature");
	succeed(subject, "write");
	for (let recovery = 1; recovery <= 3; recovery += 1) {
		start(subject, "bash", { command: "npm test" });
		end(subject, "bash", { command: "npm test" }, true);
		assert.equal(subject.snapshot().recoveryCount, recovery);
		assert.equal(subject.snapshot().progress.total, 4);
		assert.equal(activeCount(subject), 1);
		assert.ok(rows(subject).includes(`Recovery #${recovery} — correcting after failed verification`));
		succeed(subject, "edit");
	}
	succeed(subject, "bash", { command: "npm test" });
	settle(subject);
	assert.equal(subject.snapshot().state, TaskState.DONE);
	assert.deepEqual(codingProgress(subject), { done: 4, total: 4, percent: 100 });
});

test("normal settlement after recovery reconciles to 4/4 with no residual Work or Verify", () => {
	const { subject } = monitor();
	subject.begin("Refactor deterministic parser");
	succeed(subject, "edit");
	end(subject, "bash", { command: "npm test" }, true);
	succeed(subject, "edit");
	succeed(subject, "bash", { command: "npm test" });
	settle(subject);
	const snapshot = subject.snapshot();
	assert.equal(snapshot.state, TaskState.DONE);
	assert.deepEqual(snapshot.progress, { done: 4, total: 4, percent: 100 });
	assert.ok(snapshot.milestones.every((item) => item.state === MilestoneState.DONE));
	assert.equal(snapshot.recoveryActive, false);
	assert.doesNotMatch(rows(subject).join("\n"), /Recovery|4\/5|5\/5|plan refined/);
});

test("verification failure, edit, and a new successful verifier completes the current generation", () => {
	const { subject } = monitor();
	subject.begin("Fix the parser");
	succeed(subject, "edit");
	start(subject, "bash", { command: "python3 -m unittest discover -s tests -v" });
	assert.equal(milestone(subject, "Verify").state, MilestoneState.ACTIVE);
	end(subject, "bash", { command: "python3 -m unittest discover -s tests -v" }, true);
	assert.equal(subject.snapshot().recoveryCount, 1);
	assert.equal(milestone(subject, "Work").state, MilestoneState.ACTIVE);
	succeed(subject, "edit");
	succeed(subject, "bash", { command: "pytest" });
	settle(subject);
	assert.equal(subject.snapshot().state, TaskState.DONE);
	assert.deepEqual(codingProgress(subject), { done: 4, total: 4, percent: 100 });
});

test("edit after a passed verifier invalidates Verify until the new generation is tested", () => {
	const { subject } = monitor();
	subject.begin("Implement a feature");
	succeed(subject, "edit");
	succeed(subject, "bash", { command: "npm test" });
	assert.equal(milestone(subject, "Verify").state, MilestoneState.DONE);
	succeed(subject, "write");
	assert.equal(milestone(subject, "Verify").state, MilestoneState.ACTIVE);
	settle(subject);
	assert.equal(subject.snapshot().state, TaskState.INCOMPLETE);
	assert.notEqual(milestone(subject, "Verify").state, MilestoneState.DONE);
});

test("long verification lifecycle retains toolCallId evidence through updates, turns, and settlement", () => {
	const { subject } = monitor();
	subject.begin("Fix a long-running verification regression");
	succeed(subject, "edit");
	subject.toolStart("bash", { command: "npm test" }, undefined, "verify-long-1");
	assert.equal(milestone(subject, "Verify").state, MilestoneState.ACTIVE);
	for (let update = 0; update < 5; update += 1) {
		subject.toolUpdate("bash", "verify-long-1");
		assert.equal(milestone(subject, "Verify").state, MilestoneState.ACTIVE);
	}
	subject.turnEnd("toolUse");
	subject.toolEnd("bash", {}, false, undefined, "verify-long-1");
	let snapshot = subject.snapshot();
	assert.equal(milestone(subject, "Verify").state, MilestoneState.DONE);
	assert.deepEqual(snapshot.verificationRuns, [{ toolCallId: "verify-long-1", generationId: 1, started: true, settled: true, success: true, startedAt: 0, settledAt: 0 }]);
	// Other model turns without a write/edit must not invalidate this PASS.
	subject.agentStart();
	subject.turnEnd("stop");
	subject.agentEnd();
	subject.settle();
	snapshot = subject.snapshot();
	assert.equal(snapshot.state, TaskState.DONE);
	assert.deepEqual(snapshot.progress, { done: 4, total: 4, percent: 100 });
});

test("generation-scoped long verifier evidence is invalidated only by a later edit", () => {
	const { subject } = monitor();
	subject.begin("Implement a long task");
	succeed(subject, "write");
	subject.toolStart("bash", { command: "pytest -q" }, undefined, "verify-first");
	subject.toolUpdate("bash", "verify-first");
	subject.toolEnd("bash", {}, false, undefined, "verify-first");
	assert.equal(milestone(subject, "Verify").state, MilestoneState.DONE);
	succeed(subject, "edit");
	assert.equal(subject.snapshot().changeGeneration, 2);
	assert.equal(milestone(subject, "Verify").state, MilestoneState.ACTIVE);
	settle(subject);
	assert.equal(subject.snapshot().state, TaskState.INCOMPLETE);
	assert.notEqual(milestone(subject, "Verify").state, MilestoneState.DONE);
});

test("a second long verifier completes the new generation; consecutive verifiers remain correlated", () => {
	const { subject } = monitor();
	subject.begin("Refactor long task");
	succeed(subject, "edit");
	subject.toolStart("bash", { command: "npm test" }, undefined, "verify-one");
	subject.toolUpdate("bash", "verify-one");
	subject.toolEnd("bash", {}, false, undefined, "verify-one");
	succeed(subject, "write");
	subject.toolStart("bash", { command: "npm test" }, undefined, "verify-two");
	subject.toolUpdate("bash", "verify-two");
	subject.toolEnd("bash", {}, false, undefined, "verify-two");
	// A further verifier in the same generation becomes ACTIVE then settles
	// without losing the already observed generation association.
	subject.toolStart("bash", { command: "npm run lint" }, undefined, "verify-three");
	assert.equal(milestone(subject, "Verify").state, MilestoneState.ACTIVE);
	subject.toolEnd("bash", {}, false, undefined, "verify-three");
	subject.agentEnd();
	subject.settle();
	const snapshot = subject.snapshot();
	assert.equal(snapshot.state, TaskState.DONE);
	assert.deepEqual(snapshot.verificationRuns.map(({ toolCallId, generationId, started, settled, success }) => ({ toolCallId, generationId, started, settled, success })), [
		{ toolCallId: "verify-one", generationId: 1, started: true, settled: true, success: true },
		{ toolCallId: "verify-two", generationId: 2, started: true, settled: true, success: true },
		{ toolCallId: "verify-three", generationId: 2, started: true, settled: true, success: true },
	]);
});

test("agent_end before a verifier end is reconciled when the observed end arrives before agent_settled", () => {
	const { subject } = monitor();
	subject.begin("Fix ordering");
	succeed(subject, "edit");
	subject.toolStart("bash", { command: "npm test" }, undefined, "ordering-verify");
	subject.turnEnd("toolUse");
	subject.agentEnd();
	subject.toolEnd("bash", {}, false, undefined, "ordering-verify");
	subject.settle();
	assert.equal(subject.snapshot().state, TaskState.DONE);
	assert.deepEqual(subject.snapshot().progress, { done: 4, total: 4, percent: 100 });
});

test("counter and percentage are an atomic four-milestone invariant", () => {
	const { subject } = monitor();
	subject.begin("Fix atomic progress");
	const transitions = [
		() => subject.toolStart("read"), () => subject.toolEnd("read"), () => subject.toolStart("edit"), () => subject.toolEnd("edit"),
		() => subject.toolStart("bash", { command: "npm test" }, undefined, "atomic-verify"), () => subject.toolUpdate("bash", "atomic-verify"),
		() => subject.turnEnd("toolUse"), () => subject.toolEnd("bash", {}, false, undefined, "atomic-verify"), () => subject.agentEnd(), () => subject.settle(),
	];
	for (const transition of transitions) {
		transition();
		const snapshot = subject.snapshot();
		const done = snapshot.milestones.filter((item) => item.state === MilestoneState.DONE).length;
		assert.equal(snapshot.progress.done, done);
		assert.equal(snapshot.progress.percent, done * 25);
		assert.deepEqual(snapshot.progress, { done, total: 4, percent: done * 25 });
	}
});

test("normal settlement does not invent Verify DONE when the current change was not verified", () => {
	const { subject } = monitor();
	subject.begin("Add a feature");
	succeed(subject, "write");
	rows(subject);
	settle(subject);
	assert.equal(subject.snapshot().state, TaskState.INCOMPLETE);
	assert.notEqual(milestone(subject, "Verify").state, MilestoneState.DONE);
	assert.notEqual(codingProgress(subject).done, 4);
	assert.ok(rows(subject).includes("INCOMPLETE — verification evidence required"));
});

test("all normal coding transitions preserve a four-item denominator and at most one ACTIVE item", () => {
	const { subject } = monitor();
	subject.begin("Fix an error");
	const transitions = [
		() => start(subject, "read"), () => end(subject, "read"), () => start(subject, "edit"), () => end(subject, "edit"),
		() => start(subject, "bash", { command: "npm test" }), () => end(subject, "bash", { command: "npm test" }, true),
		() => start(subject, "edit"), () => end(subject, "edit"), () => start(subject, "bash", { command: "npm test" }),
		() => end(subject, "bash", { command: "npm test" }), () => subject.agentEnd(), () => subject.settle(),
	];
	for (const transition of transitions) {
		transition();
		assert.equal(codingProgress(subject).total, 4);
		assert.ok(activeCount(subject) <= 1);
	}
});

test("compact UI has at most three fitting rows and never emits widget truncation", () => {
	const { subject } = monitor();
	subject.begin("Add a feature");
	succeed(subject, "edit");
	end(subject, "bash", { command: "npm test" }, true);
	for (const width of [120, 31, 20, 8]) {
		const rendered = rows(subject, width);
		assert.ok(rendered.length <= 3);
		assert.ok(rendered.every((row) => row.length <= width), `rows fit ${width}: ${rendered.join(" | ")}`);
		assert.ok(rendered.every((row) => !row.includes("widget truncated")));
	}
	assert.equal(rows(subject, 31)[0], "Forge 2/4 50% | ✓U ▶W ○V ○F");
});

test("small stable templates are retained for investigation and testing", () => {
	const { subject } = monitor();
	subject.begin("Investigate cache misses");
	assert.deepEqual(subject.snapshot().milestones.map((item) => item.label), ["Understand", "Inspect", "Conclude", "Finalize"]);
	assert.equal(subject.snapshot().progress.total, 4);
	assert.equal(classifyTask("Run the test suite"), "testing");
});

test("very short task has no persistent widget", () => {
	const { subject } = monitor({ minVisibleMs: 10_000 });
	subject.begin("Add one line");
	succeed(subject, "write");
	settle(subject);
	assert.equal(subject.render(), undefined);
});

test("normal completion and terminal failure remain distinct", () => {
	const { subject } = monitor();
	subject.begin("Fix a bug");
	succeed(subject, "edit");
	subject.turnEnd("error");
	subject.agentEnd();
	subject.settle();
	assert.equal(subject.snapshot().state, TaskState.FAILED);
	assert.notEqual(milestone(subject, "Finalize").state, MilestoneState.DONE);
});

test("classification, bash classification, and conservative ETA remain metadata-only", () => {
	assert.equal(classifyTask("Please handle this"), "unknown");
	assert.equal(classifyBashCommand("npm test"), "verification");
	assert.equal(classifyBashCommand("cd project && python3 -m unittest discover -s tests -v"), "verification");
	assert.equal(classifyBashCommand("git status"), "other");
	assert.equal(classifyBashCommand("echo pytest"), "other");
	const { subject, advance } = monitor({ etaMinHistoryMs: 60_000 });
	subject.begin("Add a feature");
	succeed(subject, "edit");
	assert.ok(rows(subject).includes("ETA unavailable"));
	advance(60_000);
	succeed(subject, "bash", { command: "npm test" });
	assert.match(rows(subject).find((row) => row.startsWith("ETA ")), /^ETA ~\d+ min–\d+ min$/);
});

test("adapter redraws with a width-aware compact component on every live transition", async () => {
	const adapter = pathToFileURL(new URL("../src/forge-for-pi/task-progress-monitor.ts", import.meta.url).pathname).href;
	const oldForge = process.env.FORGE_FOR_PI, oldVisible = process.env.FORGE_TASK_PROGRESS_MIN_VISIBLE_MS;
	process.env.FORGE_FOR_PI = "1"; process.env.FORGE_TASK_PROGRESS_MIN_VISIBLE_MS = "0";
	try {
		const { default: install } = await import(`${adapter}?test=${Date.now()}`);
		const handlers = new Map(); const pi = { on(name, handler) { handlers.set(name, handler); } };
		install(pi);
		const widgets = []; const context = { hasUI: true, ui: { setWidget(id, content) { widgets.push([id, content]); } } };
		handlers.get("session_start")({ reason: "startup" }, context);
		handlers.get("before_agent_start")({ prompt: "Add a demo feature" }, context);
		handlers.get("agent_start")({}, context);
		handlers.get("tool_execution_start")({ toolCallId: "w", toolName: "write", args: { path: "demo" } }, context);
		handlers.get("tool_execution_end")({ toolCallId: "w", toolName: "write", isError: false }, context);
		const verifyRows = widgets.at(-1)[1]({}, {}).render(31);
		assert.ok(verifyRows.includes("Forge 2/4 50% | ✓U ✓W ▶V ○F"));
		assert.ok(verifyRows.every((row) => row.length <= 31));
		handlers.get("tool_execution_start")({ toolCallId: "t", toolName: "bash", args: { command: "npm test" } }, context);
		handlers.get("tool_execution_update")({ toolCallId: "t", toolName: "bash", args: { command: "npm test" }, partialResult: "still running" }, context);
		assert.ok(widgets.at(-1)[1]({}, {}).render(31).includes("Forge 2/4 50% | ✓U ✓W ▶V ○F"));
		handlers.get("tool_execution_end")({ toolCallId: "t", toolName: "bash", isError: false }, context);
		handlers.get("agent_end")({}, context);
		handlers.get("agent_settled")({}, context);
		const finalRows = widgets.at(-1)[1]({}, {}).render(120);
		assert.ok(finalRows.includes("Forge Task  4/4  100% | ✓ Understand | ✓ Work | ✓ Verify | ✓ Finalize"));
		handlers.get("session_shutdown")({ reason: "reload" }, context);
		handlers.get("session_start")({ reason: "new" }, context);
		assert.deepEqual(widgets.at(-1), ["forge-task-progress-monitor", undefined]);
	} finally {
		oldForge === undefined ? delete process.env.FORGE_FOR_PI : process.env.FORGE_FOR_PI = oldForge;
		oldVisible === undefined ? delete process.env.FORGE_TASK_PROGRESS_MIN_VISIBLE_MS : process.env.FORGE_TASK_PROGRESS_MIN_VISIBLE_MS = oldVisible;
	}
});

test("candidate declares exactly four active tools and no model-facing monitor API", async () => {
	const [entry, monitorSource, files] = await Promise.all([
		readFile(new URL("../src/forge-for-pi/index.ts", import.meta.url), "utf8"), readFile(new URL("../src/forge-for-pi/task-progress-monitor.ts", import.meta.url), "utf8"), readdir(new URL("../src/forge-for-pi", import.meta.url)),
	]);
	assert.match(entry, /setActiveTools\(\["read", "bash", "edit", "write"\]\)/);
	assert.doesNotMatch(monitorSource, /(?:registerTool|registerCommand|sendMessage)/);
	assert.equal(files.some((file) => new RegExp("process" + "-monitor", "i").test(file)), false);
});
