export const TaskState = Object.freeze({ RUNNING: "RUNNING", DONE: "DONE", FAILED: "FAILED" });
export const MilestoneState = Object.freeze({ PENDING: "PENDING", ACTIVE: "ACTIVE", DONE: "DONE", BLOCKED: "BLOCKED", SKIPPED: "SKIPPED" });
export const CheckState = Object.freeze({ NOT_OBSERVED: "not observed", RUNNING: "running", PASS: "PASS", FAIL: "FAIL" });

// The monitor exposes only the observed lifecycle state, never a synthetic completion metric.
// Check and recovery evidence remains host-side and does not affect the minimal UI.
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

/** Evidence-only, host-side lifecycle state. Check evidence never changes it. */
export class TaskProgressMonitor {
	constructor({ now = () => Date.now(), minVisibleMs = 2_500 } = {}) {
		this.now = now;
		this.minVisibleMs = minVisibleMs;
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
			generation: { status: "idle" },
			visible: false,
		};
		return this.result("task classified; awaiting operational evidence");
	}

	agentStart() { return this.result("agent started"); }

	// toolCallId correlates a long check with its eventual completion.
	toolStart(toolName, args = {}, at = this.now(), toolCallId) {
		if (!this.task || this.terminal()) return this.result("ignored: no running task");
		this.task.operationCount += 1;
		// Inspection is deliberately not treated as completed understanding. Only a
		// direct mutation request is concrete operational-work evidence.
		if (toolName === "edit" || toolName === "write") {
			this.complete("understand", at);
			this.activateOnly("work");
		}
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
			this.task.retries += 1;
			if (run) this.settleCheck(run, false, at);
			return this.result(run ? "check failed; recovery observed" : `${toolName} failed; lifecycle state unchanged`);
		}
		if (toolName === "edit" || toolName === "write") this.observeChange();
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
		return this.result("normal lifecycle settled");
	}

	turnStart(timestamp) {
		if (!this.task || this.terminal()) return this.result("ignored: no running task");
		// Pi 0.84.4 exposes this timestamp on turn_start. Do not substitute a
		// local estimate if it is absent: the rate must remain unavailable.
		this.task.generation = Number.isFinite(timestamp) ? { status: "pending", startedAt: timestamp } : { status: "unavailable" };
		return this.result("model turn started");
	}

	assistantMessageEnd(message, endedAt = this.now()) {
		if (!this.task || this.terminal() || message?.role !== "assistant") return this.result("ignored: no running task or assistant message");
		const startedAt = this.task.generation?.startedAt;
		const outputTokens = message?.usage?.output;
		const durationMs = endedAt - startedAt;
		// Pi only guarantees final assistant usage. Use its output field alone;
		// input and cache usage, as well as all subsequent tool time, are excluded.
		if (Number.isFinite(outputTokens) && outputTokens > 0 && Number.isFinite(startedAt) && Number.isFinite(endedAt) && durationMs > 0) {
			this.task.generation = { status: "measured", outputTokens, durationMs, tokensPerSecond: outputTokens / (durationMs / 1_000) };
		} else {
			this.task.generation = { status: "unavailable" };
		}
		return this.result("assistant output usage observed");
	}

	turnEnd(stopReason) {
		if (!this.task) return this.result("ignored: no task");
		if (stopReason === "error" || stopReason === "aborted") this.task.terminalError = true;
		else if (stopReason === "stop" || stopReason === "toolUse") this.task.terminalError = false;
		return this.result("turn state observed");
	}

	fail(at = this.now()) {
		if (!this.task || this.terminal()) return this.result("ignored: no running task");
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

	render(_width = Number.POSITIVE_INFINITY, at = this.now()) {
		if (!this.shouldRender(at) || !this.task) return undefined;
		const lifecycle = this.task.milestones.map((item) => `${marker(item.state)} ${item.label}`).join(" | ");
		const speed = formatTokensPerSecond(this.task.generation);
		return [speed === undefined ? lifecycle : `${lifecycle} | ${speed}`];
	}

	snapshot() {
		if (!this.task) return undefined;
		return structuredClone(this.task);
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
		// Keep the lifecycle ordering intact for callers that report only completion.
		this.complete("understand");
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
	complete(phase, at = this.now()) {
		const item = this.milestone(phase);
		if (!item || item.state === MilestoneState.DONE) return;
		item.state = MilestoneState.DONE;
		item.completedAt = at;
	}
	terminal() { return [TaskState.DONE, TaskState.FAILED].includes(this.task?.state); }
	startReason(toolName, args) {
		if (toolName === "bash" && classifyBashCommand(args?.command) === "verification") return "check command started; understanding remains active";
		return toolName === "edit" || toolName === "write" ? "mutation started; work active" : "inspection observed; understanding remains active";
	}
	endReason(toolName, args, check) {
		if (toolName === "bash" && check) return "check lifecycle settled";
		return toolName === "edit" || toolName === "write" ? `${toolName} succeeded; work remains active` : `${toolName} succeeded; understanding remains active`;
	}
	result(reason) { return { reason, snapshot: this.snapshot() }; }
}

function formatTokensPerSecond(generation) {
	if (generation?.status === "idle") return undefined;
	const value = generation?.tokensPerSecond;
	return Number.isFinite(value) && value > 0 ? `avg ${Math.round(value)} tok/s` : "tok/s …";
}

function marker(state) { return state === MilestoneState.DONE ? "✓" : state === MilestoneState.ACTIVE ? "▶" : "○"; }
