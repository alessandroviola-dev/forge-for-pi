import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { CheckState, MilestoneState, TaskProgressMonitor, TaskState, classifyBashCommand, classifyTask } from "../src/forge-for-pi/task-progress-monitor-core.mjs";

function monitor(options = {}) {
	let now = 0;
	return { advance(ms) { now += ms; return now; }, subject: new TaskProgressMonitor({ now: () => now, minVisibleMs: 0, ...options }) };
}
function milestone(subject, label) { return subject.snapshot().milestones.find((item) => item.label === label); }
function start(subject, tool, args = {}, id) { return subject.toolStart(tool, args, undefined, id); }
function end(subject, tool, args = {}, error = false, id) { return subject.toolEnd(tool, args, error, undefined, id); }
function settle(subject) { subject.agentEnd(); subject.settle(); }
function progress(subject) { return subject.snapshot().progress; }
function activeCount(subject) { return subject.snapshot().milestones.filter((item) => item.state === MilestoneState.ACTIVE).length; }
function rows(subject, width = 120) { return subject.render(width) ?? []; }

// Lifecycle progress is intentionally independent from check evidence.
test("normal lifecycle uses the immutable Understand, Work, Finalize plan from 0 to 3/3", () => {
	const { subject } = monitor();
	subject.begin("Add a deterministic greeting feature");
	assert.deepEqual(progress(subject), { done: 0, total: 3, percent: 0 });
	assert.deepEqual(subject.snapshot().milestones.map((item) => item.label), ["Understand", "Work", "Finalize"]);
	start(subject, "read");
	assert.equal(milestone(subject, "Understand").state, MilestoneState.DONE);
	assert.equal(milestone(subject, "Work").state, MilestoneState.ACTIVE);
	assert.deepEqual(progress(subject), { done: 1, total: 3, percent: 33 });
	assert.ok(rows(subject).length > 0);
	subject.agentEnd();
	assert.deepEqual(progress(subject), { done: 2, total: 3, percent: 67 });
	assert.equal(milestone(subject, "Finalize").state, MilestoneState.ACTIVE);
	subject.settle();
	assert.deepEqual(progress(subject), { done: 3, total: 3, percent: 100 });
	assert.equal(subject.snapshot().state, TaskState.DONE);
	assert.deepEqual(rows(subject), ["Forge 3/3 100% | ✓ Understand | ✓ Work | ✓ Finalize", "DONE | Checks: not observed"]);
});

test("edit, test, edit, test cycles remain Work and leave progress untouched", () => {
	const { subject } = monitor();
	subject.begin("Fix parser regression");
	start(subject, "edit"); end(subject, "edit");
	start(subject, "bash", { command: "npm test" }, "test-1");
	assert.equal(subject.snapshot().checks, CheckState.RUNNING);
	end(subject, "bash", { command: "npm test" }, false, "test-1");
	assert.equal(subject.snapshot().checks, CheckState.PASS);
	start(subject, "edit"); end(subject, "edit");
	assert.equal(subject.snapshot().checks, CheckState.NOT_OBSERVED);
	start(subject, "bash", { command: "npm test" }, "test-2");
	end(subject, "bash", { command: "npm test" }, false, "test-2");
	assert.equal(subject.snapshot().checks, CheckState.PASS);
	assert.deepEqual(progress(subject), { done: 2, total: 3, percent: 67 });
	assert.equal(milestone(subject, "Work").state, MilestoneState.ACTIVE);
	assert.equal(activeCount(subject), 1);
	settle(subject);
	assert.deepEqual(progress(subject), { done: 3, total: 3, percent: 100 });
});

test("PASS followed by an edit requires an observed recheck without changing progress", () => {
	const { subject } = monitor();
	subject.begin("Add validation");
	start(subject, "edit"); end(subject, "edit");
	start(subject, "bash", { command: "pytest" }, "first"); end(subject, "bash", { command: "pytest" }, false, "first");
	assert.equal(subject.snapshot().checks, CheckState.PASS);
	start(subject, "write"); end(subject, "write");
	assert.equal(subject.snapshot().checks, CheckState.NOT_OBSERVED);
	start(subject, "bash", { command: "pytest" }, "second"); end(subject, "bash", { command: "pytest" }, false, "second");
	assert.equal(subject.snapshot().checks, CheckState.PASS);
	assert.deepEqual(progress(subject), { done: 2, total: 3, percent: 67 });
});

test("failed checks create secondary recovery while Work remains the only active milestone", () => {
	const { subject } = monitor();
	subject.begin("Fix login bug");
	start(subject, "edit"); end(subject, "edit");
	start(subject, "bash", { command: "pytest" }, "failed"); end(subject, "bash", { command: "pytest" }, true, "failed");
	assert.equal(subject.snapshot().checks, CheckState.FAIL);
	assert.equal(subject.snapshot().recoveryCount, 1);
	assert.equal(subject.snapshot().recoveryActive, true);
	assert.equal(activeCount(subject), 1);
	assert.ok(rows(subject).includes("Recovery #1"));
	assert.ok(rows(subject).includes("Checks: FAIL"));
	start(subject, "edit"); end(subject, "edit");
	start(subject, "bash", { command: "pytest" }, "passed"); end(subject, "bash", { command: "pytest" }, false, "passed");
	assert.equal(subject.snapshot().checks, CheckState.PASS);
	assert.deepEqual(progress(subject), { done: 2, total: 3, percent: 67 });
	settle(subject);
	assert.ok(rows(subject).includes("DONE | Checks: PASS"));
});

test("many consecutive verifiers are secondary observations and never alter Work progress", () => {
	const { subject } = monitor();
	subject.begin("Refactor parser");
	start(subject, "edit"); end(subject, "edit");
	for (const [index, command] of ["npm test", "npm run lint", "tsc --noEmit", "pytest"].entries()) {
		const id = `check-${index}`;
		start(subject, "bash", { command }, id);
		assert.equal(subject.snapshot().checks, CheckState.RUNNING);
		end(subject, "bash", { command }, false, id);
		assert.equal(subject.snapshot().checks, CheckState.PASS);
		assert.deepEqual(progress(subject), { done: 2, total: 3, percent: 67 });
		assert.equal(activeCount(subject), 1);
	}
});

test("a normal lifecycle with no test never invents PASS", () => {
	const { subject } = monitor();
	subject.begin("Implement a small feature");
	start(subject, "read"); end(subject, "read");
	assert.ok(rows(subject).length > 0);
	settle(subject);
	assert.equal(subject.snapshot().checks, CheckState.NOT_OBSERVED);
	assert.ok(rows(subject).includes("DONE | Checks: not observed"));
});

test("short tasks do not leave a persistent widget before the reveal threshold", () => {
	const { subject } = monitor({ minVisibleMs: 2_500 });
	subject.begin("Add tiny change");
	start(subject, "read"); end(subject, "read");
	settle(subject);
	assert.equal(subject.render(), undefined);
});

test("long tasks reveal lifecycle progress, Checks running, and width-safe rows", () => {
	const { subject, advance } = monitor({ minVisibleMs: 2_500 });
	subject.begin("Implement a long feature");
	start(subject, "read"); end(subject, "read");
	advance(2_500);
	start(subject, "edit"); end(subject, "edit");
	start(subject, "bash", { command: "npm test" }, "long");
	assert.ok(rows(subject).includes("Forge 2/3 67% | ✓ Understand | ▶ Work | ○ Finalize"));
	assert.ok(rows(subject).includes("Checks: running"));
	assert.ok(rows(subject, 31).every((row) => row.length <= 31));
	assert.equal(activeCount(subject), 1);
});

test("counter, percentage, and ACTIVE invariants are fixed at 0/3, 1/3, 2/3, 3/3", () => {
	const { subject } = monitor();
	subject.begin("Unknown task");
	assert.deepEqual(progress(subject), { done: 0, total: 3, percent: 0 });
	start(subject, "bash", { command: "echo work" });
	assert.deepEqual(progress(subject), { done: 1, total: 3, percent: 33 });
	end(subject, "bash", { command: "echo work" });
	assert.deepEqual(progress(subject), { done: 2, total: 3, percent: 67 });
	assert.equal(activeCount(subject), 1);
	subject.agentEnd();
	assert.deepEqual(progress(subject), { done: 2, total: 3, percent: 67 });
	assert.equal(activeCount(subject), 1);
	subject.settle();
	assert.deepEqual(progress(subject), { done: 3, total: 3, percent: 100 });
	assert.equal(activeCount(subject), 0);
});

test("classification and check command detection remain conservative and host-side", () => {
	assert.equal(classifyTask("Fix an error"), "bugfix");
	assert.equal(classifyTask("Refactor parser"), "refactor");
	assert.equal(classifyBashCommand("npm test"), "verification");
	assert.equal(classifyBashCommand("echo test output"), "other");
});

test("launchers remain the managed exec wrappers for Forge and Forgetrace", async () => {
	const install = await readFile(new URL("../scripts/install.sh", import.meta.url), "utf8");
	assert.match(install, /exec env FORGE_FOR_PI=1 pi --no-skills "\$@"/);
	assert.match(install, /exec env FORGE_FOR_PI=1 FORGE_FOR_PI_TRACE=1 pi --no-skills "\$@"/);
});
