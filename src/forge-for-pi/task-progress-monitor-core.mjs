export const TaskState = Object.freeze({ RUNNING: "RUNNING", DONE: "DONE", FAILED: "FAILED" });
export const MilestoneState = Object.freeze({ PENDING: "PENDING", ACTIVE: "ACTIVE", DONE: "DONE", BLOCKED: "BLOCKED", SKIPPED: "SKIPPED" });
export const CheckState = Object.freeze({ NOT_OBSERVED: "not observed", RUNNING: "running", PASS: "PASS", FAIL: "FAIL" });

// Task progress deliberately measures lifecycle progress, not semantic proof.
// Checks and recovery are observed separately from this immutable three-step plan.
const TEMPLATES = Object.freeze({
	feature: ["Understand", "Work", "Finalize"],
	bugfix: ["Understand", "Work", "Finalize"],
	refactor: ["Understand", "Work", "Finalize"],
	unknown: ["Understand", "Work", "Finalize"],
	mixed: ["Understand", "Work", "Finalize"],
	investigation: ["Understand", "Work", "Finalize"],
	testing: ["Understand", "Work", "Finalize"],
});

// Match executable command forms, not arbitrary output/text containing "test".
const TEST_COMMAND = /(?:^|&&|\|\||;)\s*(?:(?:python(?:\d+(?:\.\d+)?)?|python3)\s+-m\s+(?:pytest|unittest)\b|(?:pytest|unittest|ruff|mypy|pyright|vitest|jest|eslint)\b|tsc\b(?:\s+--noEmit\b)?|(?:npm|pnpm|yarn)\s+(?:test\b|run\s+(?:test|lint|build|check)\b)|cargo\s+(?:test|check|clippy)\b|go\s+(?:test|vet)\b|(?:make|just)\s+(?:test|lint|build|check)\b)/i;
const FEATURE = /\b(?:add|implement|create|build|feature|support|introduce|aggiungi|implementa|crea|sviluppa)\b/i;
const BUGFIX = /\b(?:fix|bug|broken|failure|regression|errore|correggi|ripara)\b/i;
const REFACTOR = /\b(?:refactor|restructure|cleanup|clean up|rename|simplif|ristruttura|ripulisci)\b/i;
const INVESTIGATION = /\b(?:investigat\w*|analy[sz]e|analysis|diagnos\w*|root cause|why\b|explain|inspect|research|analizza|analisi|indaga|spiega)\b/i;
const TESTING = /\b(?:test|tests|testing|verification|verifica)\b/i;

export function classifyTask(prompt) {
	const text = typeof prompt === "string" ? prompt : "";
	const matches = [["bugfix", BUGFIX], ["refactor", REFACTOR], ["investigation", INVESTIGATION], ["testing", TESTING], ["feature", FEATURE]]
		.filter(([, expression]) => expression.test(text)).map(([kind]) => kind);
	return matches.length === 1 ? matches[0] : matches.length > 1 ? "mixed" : "unknown";
}

export function classifyBashCommand(command) {
	return typeof command === "string" && TEST_COMMAND.test(command) ? "verification" : "other";
}

/** Evidence-only, host-side lifecycle progress. Checks never affect progress. */
export class TaskProgressMonitor {
	constructor({ now = () => Date.now(), minVisibleMs = 2_500, etaMinHistoryMs = 8_000 } = {}) {
		this.now = now;
		this.minVisibleMs = minVisibleMs;
		this.etaMinHistoryMs = etaMinHistoryMs;
		this.task = undefined;
	}

	reset() { this.task = undefined; }

	begin(prompt, at = this.now()) {
		const category = classifyTask(prompt);
		this.task = {
			category, startedAt: at, state: TaskState.RUNNING,
			milestones: TEMPLATES[category].map((label, index) => ({ label, state: index === 0 ? MilestoneState.ACTIVE : MilestoneState.PENDING })),
			operationCount: 0, changes: 0, changeGeneration: 0,
			checkRuns: [], verificationRuns: [], checkSequence: 0,
			checks: CheckState.NOT_OBSERVED,
			retries: 0, recoveryCount: 0, recoveryActive: false, terminalError: false,
			// Work may remain ACTIVE through cycles after its lifecycle step is reached.
			progressFloor: 0, visible: false,
		};
		return this.result("task classified; awaiting operational evidence");
	}

	agentStart() { return this.result("agent started"); }

	// toolCallId correlates a long check with its eventual completion.
	toolStart(toolName, args = {}, at = this.now(), toolCallId) {
		if (!this.task || this.terminal()) return this.result("ignored: no running task");
		this.task.operationCount += 1;
		this.complete("understand", at);
		this.activateOnly("work");
		if (toolName === "bash" && classifyBashCommand(args?.command) === "verification") this.startCheck(toolCallId, at);
		return this.result(this.startReason(toolName, args));
	}

	toolUpdate(toolName, toolCallId) {
		if (!this.task || this.terminal()) return this.result("ignored: no running task");
		const run = toolName === "bash" ? this.checkRun(toolCallId) : undefined;
		return this.result(run && !run.settled ? "check update observed" : "tool update observed");
	}

	toolEnd(toolName, args = {}, isError = false, at = this.now(), toolCallId) {
		if (!this.task || this.terminal()) return this.result("ignored: no running task");
		const run = toolName === "bash" ? this.checkRun(toolCallId, args) : undefined;
		if (isError) {
			this.markWorkReached();
			this.task.retries += 1;
			if (run) this.settleCheck(run, false, at);
			return this.result(run ? "check failed; recovery observed" : `${toolName} failed; work remains active`);
		}
		if (toolName === "edit" || toolName === "write") this.observeChange();
		this.markWorkReached();
		if (run) this.settleCheck(run, true, at);
		return this.result(this.endReason(toolName, args, Boolean(run)));
	}

	agentEnd() {
		if (!this.task || this.terminal()) return this.result("ignored: no running task");
		this.complete("understand");
		this.complete("work");
		this.activateOnly("finalize");
		return this.result("operational work ended; finalization active");
	}

	settle(at = this.now()) {
		if (!this.task || this.terminal()) return this.result("ignored: no running task");
		if (this.task.terminalError) return this.fail(at);
		for (const phase of ["understand", "work", "finalize"]) this.complete(phase, at);
		this.task.recoveryActive = false;
		this.task.state = TaskState.DONE;
		return this.result("normal lifecycle settled to 3/3");
	}

	turnEnd(stopReason) {
		if (!this.task) return this.result("ignored: no task");
		if (stopReason === "error" || stopReason === "aborted") this.task.terminalError = true;
		else if (stopReason === "stop" || stopReason === "toolUse") this.task.terminalError = false;
		return this.result("turn state observed");
	}

	fail(at = this.now()) {
		if (!this.task || this.terminal()) return this.result("ignored: no running task");
		const active = this.task.milestones.find((milestone) => milestone.state === MilestoneState.ACTIVE);
		if (active) active.state = MilestoneState.BLOCKED;
		this.task.state = TaskState.FAILED;
		return this.result("agent ended with an error");
	}

	shouldRender(at = this.now()) {
		if (!this.task) return false;
		if (this.task.visible) return true;
		if (this.terminal()) return false;
		if (this.task.operationCount >= 3 || (this.task.operationCount > 0 && at - this.task.startedAt >= this.minVisibleMs)) this.task.visible = true;
		return this.task.visible;
	}

	render(width = Number.POSITIVE_INFINITY, at = this.now()) {
		if (!this.shouldRender(at) || !this.task) return undefined;
		const { done, total, percent } = this.progress();
		const full = `Forge ${done}/${total} ${percent}% | ${this.task.milestones.map((item) => `${marker(item.state)} ${item.label}`).join(" | ")}`;
		const compact = `Forge ${done}/${total} ${percent}% | ${this.task.milestones.map((item) => `${marker(item.state)}${item.label[0]}`).join(" ")}`;
		const rows = [fit(full, compact, width)];
		if (this.task.state === TaskState.DONE) rows.push(fit(`DONE | Checks: ${this.task.checks}`, `DONE | Checks: ${this.task.checks}`, width));
		else {
			if (this.task.recoveryActive) rows.push(fit(`Recovery #${this.task.recoveryCount}`, `Recovery #${this.task.recoveryCount}`, width));
			rows.push(fit(`Checks: ${this.task.checks}`, `Checks: ${this.task.checks}`, width));
		}
		return rows.slice(0, 3);
	}

	snapshot() {
		if (!this.task) return undefined;
		return structuredClone({ ...this.task, progress: this.progress() });
	}

	startCheck(toolCallId, at) {
		const id = toolCallId ?? `legacy-check-${++this.task.checkSequence}`;
		let run = this.task.checkRuns.find((item) => item.toolCallId === id);
		if (!run) {
			run = { toolCallId: id, generationId: this.task.changeGeneration, started: true, settled: false, success: undefined, startedAt: at };
			this.task.checkRuns.push(run);
			this.task.verificationRuns = this.task.checkRuns;
		}
		this.task.checks = CheckState.RUNNING;
		this.task.recoveryActive = false;
	}

	checkRun(toolCallId, args) {
		if (toolCallId !== undefined) return this.task.checkRuns.find((run) => run.toolCallId === toolCallId && !run.settled);
		if (classifyBashCommand(args?.command) !== "verification") return undefined;
		return [...this.task.checkRuns].reverse().find((run) => !run.settled) ?? this.implicitCheck();
	}

	implicitCheck() {
		const run = { toolCallId: `legacy-check-${++this.task.checkSequence}`, generationId: this.task.changeGeneration, started: true, settled: false, success: undefined, startedAt: this.now() };
		this.task.checkRuns.push(run);
		this.task.verificationRuns = this.task.checkRuns;
		return run;
	}

	settleCheck(run, success, at) {
		run.settled = true;
		run.success = success;
		run.settledAt = at;
		if (!success) {
			this.task.checks = CheckState.FAIL;
			this.task.recoveryCount += 1;
			this.task.recoveryActive = true;
			return;
		}
		this.task.checks = run.generationId === this.task.changeGeneration ? CheckState.PASS : CheckState.NOT_OBSERVED;
		this.task.recoveryActive = false;
	}

	observeChange() {
		this.task.changes += 1;
		this.task.changeGeneration += 1;
		this.task.recoveryActive = false;
		// A PASS belongs only to the generation in which it was observed.
		if (this.task.checks === CheckState.PASS) this.task.checks = CheckState.NOT_OBSERVED;
		this.activateOnly("work");
	}

	phaseIndex(phase) { return ({ understand: 0, work: 1, finalize: 2 })[phase] ?? -1; }
	milestone(phase) { return this.task?.milestones[this.phaseIndex(phase)]; }
	activateOnly(phase) {
		const target = this.milestone(phase);
		if (!target || target.state === MilestoneState.DONE) return;
		for (const milestone of this.task.milestones) if (milestone !== target && milestone.state === MilestoneState.ACTIVE) milestone.state = MilestoneState.PENDING;
		target.state = MilestoneState.ACTIVE;
	}
	markWorkReached() { this.task.progressFloor = Math.max(this.task.progressFloor, 2); }
	complete(phase, at = this.now()) {
		const item = this.milestone(phase);
		if (!item || item.state === MilestoneState.DONE) return;
		item.state = MilestoneState.DONE;
		item.completedAt = at;
	}
	progress() {
		const milestones = this.task?.milestones ?? [];
		const done = Math.max(milestones.filter((item) => item.state === MilestoneState.DONE).length, this.task?.progressFloor ?? 0);
		const total = milestones.length;
		const percent = total ? Math.round((done / total) * 100) : 0;
		if (total === 3 && percent !== [0, 33, 67, 100][done]) throw new Error(`Task Progress invariant violated: ${done}/3 cannot be ${percent}%`);
		return { done, total, percent };
	}
	terminal() { return [TaskState.DONE, TaskState.FAILED].includes(this.task?.state); }
	startReason(toolName, args) {
		if (toolName === "bash" && classifyBashCommand(args?.command) === "verification") return "check command started; work remains active";
		return "operational tool started; understanding complete";
	}
	endReason(toolName, args, check) {
		if (toolName === "bash" && check) return "check lifecycle settled";
		return `${toolName} succeeded; work remains active`;
	}
	result(reason) { return { reason, snapshot: this.snapshot() }; }
}

function marker(state) { return state === MilestoneState.DONE ? "✓" : state === MilestoneState.ACTIVE ? "▶" : state === MilestoneState.BLOCKED ? "!" : "○"; }
function fit(full, compact, width) {
	const safeWidth = Math.max(1, Number.isFinite(width) ? Math.floor(width) : full.length);
	if (full.length <= safeWidth) return full;
	if (compact.length <= safeWidth) return compact;
	const minimal = compact.startsWith("Forge ") ? compact.match(/^Forge \d+\/\d+ \d+%/)?.[0] ?? "Forge" : compact;
	return minimal.length <= safeWidth ? minimal : minimal.slice(0, safeWidth);
}
