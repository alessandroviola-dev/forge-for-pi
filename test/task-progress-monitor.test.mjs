import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { CheckState, MilestoneState, TaskProgressMonitor, TaskState, classifyBashCommand, classifyTask } from "../src/forge-for-pi/task-progress-monitor-core.mjs";

const UI = Object.freeze({
	understand: "▶ Understand | ○ Work | ○ Finalize",
	work: "✓ Understand | ▶ Work | ○ Finalize",
	finalize: "✓ Understand | ✓ Work | ▶ Finalize",
	done: "✓ Understand | ✓ Work | ✓ Finalize",
});

function monitor(options = {}) {
	let now = 0;
	return { advance(ms) { now += ms; return now; }, subject: new TaskProgressMonitor({ now: () => now, minVisibleMs: 0, ...options }) };
}
function milestone(subject, label) { return subject.snapshot().milestones.find((item) => item.label === label); }
function start(subject, tool, args = {}, id) { return subject.toolStart(tool, args, undefined, id); }
function end(subject, tool, args = {}, error = false, id) { return subject.toolEnd(tool, args, error, undefined, id); }
function rows(subject, width = 120) { return subject.render(width) ?? []; }

// The UI intentionally exposes lifecycle state plus only a measured output rate.
test("renderer has exactly the four minimal lifecycle rows", () => {
	const { subject } = monitor();
	subject.begin("Add a deterministic greeting feature");

	start(subject, "read");
	assert.deepEqual(rows(subject), [UI.understand]);

	start(subject, "edit");
	assert.deepEqual(rows(subject), [UI.work]);

	subject.agentEnd();
	assert.deepEqual(rows(subject), [UI.finalize]);

	subject.settle();
	assert.deepEqual(rows(subject), [UI.done]);
	assert.equal(subject.snapshot().state, TaskState.DONE);
});

test("initial reads and inspection commands leave Understand active", () => {
	const { subject } = monitor();
	subject.begin("Investigate the parser");

	start(subject, "read"); end(subject, "read");
	start(subject, "read"); end(subject, "read");
	start(subject, "bash", { command: "rg parser src" }); end(subject, "bash", { command: "rg parser src" });

	assert.equal(milestone(subject, "Understand").state, MilestoneState.ACTIVE);
	assert.equal(milestone(subject, "Work").state, MilestoneState.PENDING);
	assert.deepEqual(rows(subject), [UI.understand]);
	assert.equal(subject.snapshot().progress, undefined);
});

test("only a direct edit or write request moves Understand to Work", () => {
	for (const tool of ["edit", "write"]) {
		const { subject } = monitor();
		subject.begin("Implement the change");
		start(subject, "read");
		start(subject, tool);

		assert.equal(milestone(subject, "Understand").state, MilestoneState.DONE);
		assert.equal(milestone(subject, "Work").state, MilestoneState.ACTIVE);
		assert.deepEqual(rows(subject), [UI.work]);
	}
});

test("checks and recovery remain internal and never add UI rows", () => {
	const { subject } = monitor();
	subject.begin("Add validation");
	start(subject, "edit"); end(subject, "edit");
	start(subject, "bash", { command: "pytest" }, "failed"); end(subject, "bash", { command: "pytest" }, true, "failed");

	assert.equal(subject.snapshot().checks, CheckState.FAIL);
	assert.equal(subject.snapshot().recoveryActive, true);
	assert.deepEqual(rows(subject), [UI.work]);
	assert.doesNotMatch(rows(subject).join("\n"), /(?:Checks|Recovery|\d\/3|%|ETA)/);
});

test("verification cycles preserve Work and do not affect the renderer", () => {
	const { subject } = monitor();
	subject.begin("Fix deterministic validation");
	start(subject, "edit"); end(subject, "edit");
	for (const [index, command] of ["npm test", "npm run lint", "tsc --noEmit", "pytest"].entries()) {
		const id = `check-${index}`;
		start(subject, "bash", { command }, id);
		assert.equal(subject.snapshot().checks, CheckState.RUNNING);
		end(subject, "bash", { command }, false, id);
		assert.equal(subject.snapshot().checks, CheckState.PASS);
		assert.deepEqual(rows(subject), [UI.work]);
	}
});

test("uses finalized output usage and generation time for tok/s", () => {
	const { subject, advance } = monitor();
	subject.begin("Add output-rate status");
	start(subject, "read");
	subject.turnStart(0);
	advance(2_000);
	subject.assistantMessageEnd({ role: "assistant", usage: { input: 999, output: 82, cacheRead: 888, cacheWrite: 777 } });
	assert.deepEqual(rows(subject), ["▶ Understand | ○ Work | ○ Finalize | avg 41 tok/s"]);
	assert.deepEqual(subject.snapshot().generation, { status: "measured", outputTokens: 82, durationMs: 2_000, tokensPerSecond: 41 });
});

test("missing, zero, or zero-duration output usage never invents a rate", () => {
	for (const message of [
		{ role: "assistant" },
		{ role: "assistant", usage: { output: 0 } },
		{ role: "assistant", usage: { output: Number.NaN } },
		{ role: "assistant", usage: { output: Number.POSITIVE_INFINITY } },
		{ role: "assistant", usage: { output: 10 } },
	]) {
		const { subject } = monitor();
		subject.begin("Add output-rate status");
		start(subject, "read");
		subject.turnStart(0);
		subject.assistantMessageEnd(message, message.usage?.output === 10 ? 0 : 2_000);
		assert.deepEqual(rows(subject), ["▶ Understand | ○ Work | ○ Finalize | tok/s …"]);
		assert.equal(Number.isFinite(subject.snapshot().generation.tokensPerSecond), false);
		assert.doesNotMatch(rows(subject)[0], /(?:NaN|Infinity)/);
	}
});

test("multiple turns clear stale rates and exclude tool time", () => {
	const { subject, advance } = monitor();
	subject.begin("Add output-rate status");
	start(subject, "read");
	subject.turnStart(0);
	advance(1_000);
	subject.assistantMessageEnd({ role: "assistant", usage: { output: 20 } });
	assert.match(rows(subject)[0], /avg 20 tok\/s$/);
	// A tool between generations does not change the completed model rate.
	start(subject, "bash", { command: "npm test" }, "check");
	advance(10_000);
	end(subject, "bash", { command: "npm test" }, false, "check");
	assert.match(rows(subject)[0], /avg 20 tok\/s$/);
	// The next model turn has no reliable completed measurement yet.
	subject.turnStart(11_000);
	assert.deepEqual(rows(subject), ["▶ Understand | ○ Work | ○ Finalize | tok/s …"]);
	advance(500);
	subject.assistantMessageEnd({ role: "assistant", usage: { output: 30 } });
	assert.match(rows(subject)[0], /avg 60 tok\/s$/);
	assert.equal(subject.snapshot().generation.durationMs, 500);
});

test("short tasks remain suppressed", () => {
	const { subject } = monitor({ minVisibleMs: 2_500 });
	subject.begin("Tiny change");
	start(subject, "read"); end(subject, "read");
	subject.agentEnd(); subject.settle();
	assert.equal(subject.render(), undefined);
});

test("long inspection reveals the Understand row without inventing progress", () => {
	const { subject, advance } = monitor({ minVisibleMs: 2_500 });
	subject.begin("Investigate a regression");
	start(subject, "read");
	advance(2_500);
	assert.deepEqual(rows(subject, 1), [UI.understand]);
});

test("classification and check command detection remain conservative and host-side", () => {
	assert.equal(classifyTask("Fix an error"), "bugfix");
	assert.equal(classifyTask("Refactor parser"), "refactor");
	assert.equal(classifyBashCommand("npm test"), "verification");
	assert.equal(classifyBashCommand("echo test output"), "other");
});

test("launchers remain the managed exec wrappers for Forge and Forgetrace", async () => {
	const install = await readFile(new URL("../scripts/install.sh", import.meta.url), "utf8");
	assert.match(install, /FORGE_FOR_PI=1 pi --no-extensions --extension /);
	assert.match(install, /FORGE_FOR_PI=1 FORGE_FOR_PI_TRACE=1 pi --no-extensions --extension /);
	assert.match(install, /--no-skills "\$@"/);
});
