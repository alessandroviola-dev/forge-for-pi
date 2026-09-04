export const TaskState = Object.freeze({ RUNNING: "RUNNING", VERIFYING: "VERIFYING", DONE: "DONE", FAILED: "FAILED", INCOMPLETE: "INCOMPLETE" });
export const MilestoneState = Object.freeze({ PENDING: "PENDING", ACTIVE: "ACTIVE", DONE: "DONE", BLOCKED: "BLOCKED", SKIPPED: "SKIPPED" });

// Coding work deliberately has one immutable four-step plan.  Read evidence is
// useful for understanding, but is not a progress item of its own.
const TEMPLATES = Object.freeze({
	feature: ["Understand", "Work", "Verify", "Finalize"],
	bugfix: ["Understand", "Work", "Verify", "Finalize"],
	refactor: ["Understand", "Work", "Verify", "Finalize"],
	unknown: ["Understand", "Work", "Verify", "Finalize"],
	mixed: ["Understand", "Work", "Verify", "Finalize"],
	investigation: ["Understand", "Inspect", "Conclude", "Finalize"],
	testing: ["Understand", "Run", "Resolve", "Finalize"],
});

// Match executable command forms, not arbitrary output/text containing "test".
// A shell prefix (for example `cd app &&`) is allowed because the final segment
// is still an explicit verifier.
const TEST_COMMAND = /(?:^|&&|\|\||;)\s*(?:(?:python(?:\d+(?:\.\d+)?)?|python3)\s+-m\s+(?:pytest|unittest)\b|(?:pytest|unittest|ruff|mypy|pyright|vitest|jest|eslint)\b|tsc\b(?:\s+--noEmit\b)?|(?:npm|pnpm|yarn)\s+(?:test\b|run\s+(?:test|lint|build|check)\b)|cargo\s+(?:test|check|clippy)\b|go\s+(?:test|vet)\b|(?:make|just)\s+(?:test|lint|build|check)\b)/i;
const FEATURE = /\b(?:add|implement|create|build|feature|support|introduce|aggiungi|implementa|crea|sviluppa)\b/i;
const BUGFIX = /\b(?:fix|bug|broken|failure|regression|errore|correggi|ripara)\b/i;
const REFACTOR = /\b(?:refactor|cleanup|clean\s*up|restructure|semplifica|riorganizza)\b/i;
const INVESTIGATION = /\b(?:investigat\w*|analy[sz]e|analysis|diagnos\w*|root cause|why\b|explain|inspect|research|analizza|analisi|indaga|spiega)\b/i;
const TESTING = /\b(?:test|tests|testing|verification|verifica)\b/i;

export function classifyTask(prompt) {
	const text = typeof prompt === "string" ? prompt.trim() : "";
	const matches = [["bugfix", BUGFIX], ["refactor", REFACTOR], ["investigation", INVESTIGATION], ["testing", TESTING], ["feature", FEATURE]]
		.filter(([, expression]) => expression.test(text)).map(([kind]) => kind);
	return matches.length === 1 ? matches[0] : matches.length > 1 ? "mixed" : "unknown";
}

export function classifyBashCommand(command) {
	return typeof command === "string" && TEST_COMMAND.test(command) ? "verification" : "other";
}

/** Evidence-only lifecycle state machine for the host-side progress widget. */
export class TaskProgressMonitor {
	constructor({ now = () => Date.now(), minVisibleMs = 2_500, etaMinHistoryMs = 60_000 } = {}) {
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
			operationCount: 0, changes: 0, changeGeneration: 0, verifiedGeneration: -1,
			// Runs are retained for the task so final settlement can reconcile only
			// tool lifecycle evidence that was actually observed.
			verificationRuns: [], verificationSequence: 0,
			retries: 0, recoveryCount: 0, recoveryActive: false, terminalError: false,
			// Historical completion keeps the user-facing plan monotonic while the
			// active marker can move back for recovery or a new generation.
			progressFloor: 0, visible: false,
		};
		return this.result("task classified; awaiting operational evidence");
	}

	// toolCallId is deliberately part of the state-machine API.  A long bash
	// command can emit many updates and finish in a later turn; command arguments
	// alone are not a safe correlation key.
	toolStart(toolName, args = {}, at = this.now(), toolCallId) {
		if (!this.task || this.terminal()) return this.result("ignored: no running task");
		this.task.operationCount += 1;
		this.complete("understand", at);
		const verification = toolName === "bash" && classifyBashCommand(args?.command) === "verification";

		if (this.isCoding()) {
			if (toolName === "edit" || toolName === "write") this.activateOnly("work");
			if (verification) this.startVerification(toolCallId, at);
		} else if (this.task.category === "investigation" && toolName === "read") {
			this.activateOnly("inspect");
		} else if (this.task.category === "testing" && verification) {
			this.activateOnly("run");
		}
		return this.result(this.startReason(toolName, args));
	}

	toolUpdate(toolName, toolCallId) {
		if (!this.task || this.terminal()) return this.result("ignored: no running task");
		const run = toolName === "bash" ? this.verificationRun(toolCallId) : undefined;
		return this.result(run && run.started && !run.settled ? "verification update observed" : "tool update observed");
	}

	toolEnd(toolName, args = {}, isError = false, at = this.now(), toolCallId) {
		if (!this.task || this.terminal()) return this.result("ignored: no running task");
		const run = toolName === "bash" ? this.verificationRun(toolCallId, args) : undefined;
		const verification = Boolean(run);
		if (isError) {
			this.task.retries += 1;
			if (this.isCoding() && verification) this.settleVerification(run, false, at);
			return this.result(verification ? "verification failed; recovery active" : `${toolName} failed; milestone remains open`);
		}

		if (this.isCoding()) {
			if (toolName === "edit" || toolName === "write") this.observeChange(at);
			if (verification) this.settleVerification(run, true, at);
		} else if (this.task.category === "investigation" && toolName === "read") {
			this.complete("inspect", at);
		} else if (this.task.category === "testing" && verification) {
			this.complete("run", at);
			this.activateOnly("resolve");
		}
		return this.result(this.endReason(toolName, args, verification));
	}

	agentStart() {
		if (!this.task || this.terminal()) return this.result("ignored: no running task");
		const finalize = this.milestone("finalize");
		if (finalize?.state === MilestoneState.ACTIVE) finalize.state = MilestoneState.PENDING;
		return this.result("agent run started");
	}

	agentEnd() {
		if (!this.task || this.terminal()) return this.result("ignored: no running task");
		this.activateOnly("finalize");
		return this.result("agent run ended; awaiting final settlement");
	}

	settle(at = this.now()) {
		if (!this.task || this.terminal()) return this.result("ignored: no running task");
		if (this.task.terminalError) return this.fail(at);

		this.complete("finalize", at);
		if (this.isCoding() && this.hasCompleteCodingEvidence()) {
			// A normal settlement reconciles transient recovery/work states only when
			// the current modification generation has a successful verification.
			for (const phase of ["understand", "work", "verify", "finalize"]) this.complete(phase, at);
			this.task.recoveryActive = false;
			this.task.state = TaskState.DONE;
		} else {
			// Do not manufacture a verified result for an unverified coding task.
			this.task.state = TaskState.INCOMPLETE;
		}
		return this.result(this.task.state === TaskState.DONE ? "normal settlement reconciled to 4/4" : "normal settlement lacks required evidence");
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
		const full = `Forge Task  ${done}/${total}  ${percent}% | ${this.task.milestones.map((item) => `${marker(item.state)} ${item.label}`).join(" | ")}`;
		const compact = `Forge ${done}/${total} ${percent}% | ${this.task.milestones.map((item) => `${marker(item.state)}${item.label[0]}`).join(" ")}`;
		const rows = [fit(full, compact, width)];
		if (this.task.recoveryActive) rows.push(fit(`Recovery #${this.task.recoveryCount} — correcting after failed verification`, `Recovery #${this.task.recoveryCount}`, width));
		else if (this.task.state === TaskState.DONE) rows.push(fit("DONE", "DONE", width));
		else if (this.task.state === TaskState.INCOMPLETE) rows.push(fit("INCOMPLETE — verification evidence required", "INCOMPLETE", width));
		else if (done >= 2) rows.push(fit(this.eta(at) ?? "ETA unavailable", "ETA unavailable", width));
		return rows.slice(0, 3);
	}

	snapshot() {
		if (!this.task) return undefined;
		return structuredClone({ ...this.task, progress: this.progress() });
	}

	isCoding() { return ["feature", "bugfix", "refactor", "unknown", "mixed"].includes(this.task.category); }
	hasCompleteCodingEvidence() {
		// Do not trust a visual milestone or a stale cache at settlement.  The run
		// record is the observed source of truth and is generation-scoped.
		return this.task.changes > 0 && this.task.verificationRuns.some((run) =>
			run.started && run.settled && run.success === true && run.generationId === this.task.changeGeneration,
		) && this.milestone("understand")?.state === MilestoneState.DONE;
	}

	startVerification(toolCallId, at) {
		const id = toolCallId ?? `legacy-verification-${++this.task.verificationSequence}`;
		// Starts are idempotent because a host may replay a lifecycle notification.
		if (!this.task.verificationRuns.some((run) => run.toolCallId === id)) {
			this.task.verificationRuns.push({ toolCallId: id, generationId: this.task.changeGeneration, started: true, settled: false, success: undefined, startedAt: at });
		}
		this.task.recoveryActive = false;
		this.task.state = TaskState.VERIFYING;
		// Even a second verifier after a previous PASS is actively running.
		this.activateOnly("verify", true);
	}

	verificationRun(toolCallId, args) {
		if (toolCallId !== undefined) return this.task.verificationRuns.find((run) => run.toolCallId === toolCallId && !run.settled);
		// Compatibility for direct core callers.  The production adapter always
		// supplies toolCallId, so it can never accidentally bind unrelated bash runs.
		if (classifyBashCommand(args?.command) !== "verification") return undefined;
		return [...this.task.verificationRuns].reverse().find((run) => !run.settled) ?? this.implicitVerification(args);
	}

	implicitVerification() {
		const id = `legacy-verification-${++this.task.verificationSequence}`;
		const run = { toolCallId: id, generationId: this.task.changeGeneration, started: true, settled: false, success: undefined, startedAt: this.now() };
		this.task.verificationRuns.push(run);
		return run;
	}

	settleVerification(run, success, at) {
		run.settled = true;
		run.success = success;
		run.settledAt = at;
		if (!success) {
			this.enterRecovery(at);
			return;
		}
		// A verifier that started before a later edit is valid evidence for its own
		// generation only; it must not complete Verify for the newer generation.
		if (run.generationId === this.task.changeGeneration && this.task.changes > 0) {
			this.task.verifiedGeneration = run.generationId;
			this.complete("verify", at);
		}
		this.task.recoveryActive = false;
		this.task.state = TaskState.RUNNING;
	}

	observeChange(at) {
		this.task.changes += 1;
		this.task.changeGeneration += 1;
		this.task.verifiedGeneration = -1;
		this.task.recoveryActive = false;
		this.complete("work", at);
		// A successful verifier applies only to the generation it observed.
		// A later edit/write makes Verify pending again and requires a new run.
		const verify = this.milestone("verify");
		if (verify?.state === MilestoneState.DONE) verify.state = MilestoneState.PENDING;
		this.activateOnly("verify");
		this.task.state = TaskState.RUNNING;
	}

	enterRecovery() {
		this.task.recoveryCount += 1;
		this.task.recoveryActive = true;
		this.task.verifiedGeneration = -1;
		const verify = this.milestone("verify");
		if (verify?.state === MilestoneState.DONE) verify.state = MilestoneState.PENDING;
		this.activateOnly("work");
		this.task.state = TaskState.RUNNING;
	}

	phaseIndex(phase) {
		const aliases = this.isCoding()
			? { understand: 0, work: 1, verify: 2, finalize: 3 }
			: this.task.category === "investigation"
				? { understand: 0, inspect: 1, conclude: 2, finalize: 3 }
				: { understand: 0, run: 1, resolve: 2, finalize: 3 };
		return aliases[phase] ?? -1;
	}
	milestone(phase) { return this.task?.milestones[this.phaseIndex(phase)]; }
	activateOnly(phase, reactivate = false) {
		const target = this.milestone(phase);
		if (!target || target.state === MilestoneState.DONE && phase !== "work" && !reactivate) return;
		for (const milestone of this.task.milestones) if (milestone !== target && milestone.state === MilestoneState.ACTIVE) milestone.state = MilestoneState.PENDING;
		target.state = MilestoneState.ACTIVE;
	}
	complete(phase, at) {
		const item = this.milestone(phase);
		if (!item || item.state === MilestoneState.DONE || item.state === MilestoneState.SKIPPED) return;
		item.state = MilestoneState.DONE;
		item.completedAt = at;
		this.task.progressFloor = Math.max(this.task.progressFloor, this.rawDoneCount());
	}
	progress() {
		// One atomic state snapshot produces both fields.  progressFloor represents
		// completed plan evidence retained during a recovery; it and the milestone
		// states are read once before deriving both counter and percentage.
		const milestones = this.task?.milestones ?? [];
		const floor = this.task?.progressFloor ?? 0;
		const done = Math.max(milestones.filter((item) => item.state === MilestoneState.DONE).length, floor);
		const total = milestones.length;
		const percent = total ? Math.round((done / total) * 100) : 0;
		if (total === 4 && percent !== done * 25) throw new Error(`Task Progress invariant violated: ${done}/4 cannot be ${percent}%`);
		return { done, total, percent };
	}
	rawDoneCount() { return this.task?.milestones.filter((item) => item.state === MilestoneState.DONE).length ?? 0; }
	terminal() { return [TaskState.DONE, TaskState.FAILED, TaskState.INCOMPLETE].includes(this.task?.state); }
	startReason(toolName, args) {
		if (toolName === "read") return "operational read started; understanding complete";
		if (toolName === "edit" || toolName === "write") return "change started; work active";
		if (toolName === "bash" && classifyBashCommand(args?.command) === "verification") return "verification command started";
		return "operational tool started; understanding complete";
	}
	endReason(toolName, args, verification = toolName === "bash" && classifyBashCommand(args?.command) === "verification") {
		if (toolName === "read") return "read succeeded";
		if (toolName === "edit" || toolName === "write") return "change candidate ready for verification";
		if (toolName === "bash" && verification) return "verification lifecycle settled";
		return `${toolName} succeeded; no milestone evidence`;
	}
	eta(at) {
		if (!this.task || this.task.retries > 0 || this.progress().done < 2) return undefined;
		const completed = this.task.milestones.filter((item) => item.completedAt !== undefined);
		const history = at - this.task.startedAt;
		if (completed.length < 2 || history < this.etaMinHistoryMs) return undefined;
		const remaining = this.progress().total - this.progress().done;
		if (remaining <= 0) return undefined;
		const estimate = (history / this.progress().done) * remaining;
		return `ETA ~${minutes(estimate * 0.75)}–${minutes(estimate * 1.5)}`;
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
function minutes(milliseconds) { return `${Math.max(1, Math.round(milliseconds / 60_000))} min`; }
