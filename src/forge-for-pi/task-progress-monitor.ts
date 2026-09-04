import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { claimForgeComponent } from "./forge-runtime.mjs";
import { TaskProgressMonitor, classifyBashCommand } from "./task-progress-monitor-core.mjs";

const WIDGET_ID = "forge-task-progress-monitor";
const CLEAR_AFTER_SETTLE_MS = 4_000;

type ToolArgs = { command?: unknown } | undefined;
type VerificationRun = { toolCallId: string; generationId: number; started: boolean; settled: boolean; success?: boolean };
type Snapshot = { startedAt?: number; changeGeneration?: number; milestones?: Array<{ label: string; state: string }>; verificationRuns?: VerificationRun[] }; 
type Transition = { reason?: string; snapshot?: Snapshot } | undefined;

function enabled(): boolean {
	const value = process.env.FORGE_TASK_PROGRESS_MONITOR?.trim().toLowerCase();
	return value !== "0" && value !== "false" && value !== "off";
}
function visibleAfterMs(): number {
	const value = Number(process.env.FORGE_TASK_PROGRESS_MIN_VISIBLE_MS);
	return Number.isFinite(value) && value >= 0 ? value : 2_500;
}
function debugEnabled(): boolean {
	const value = process.env.FORGE_TASK_PROGRESS_DEBUG?.trim().toLowerCase();
	return value === "1" || value === "true" || value === "debug";
}
function milestoneStates(snapshot: Snapshot | undefined): Array<{ label: string; state: string }> | undefined {
	return snapshot?.milestones?.map(({ label, state }) => ({ label, state }));
}

/**
 * TUI-only lifecycle adapter. setWidget is Pi 0.84.4's reactive widget API:
 * each call replaces the widget content and requests the interactive redraw.
 */
export default function taskProgressMonitor(pi: ExtensionAPI): void {
	if (!claimForgeComponent(pi, "task-progress-monitor") || !enabled()) return;
	const minVisibleMs = visibleAfterMs();
	const monitor = new TaskProgressMonitor({ minVisibleMs });
	let ui: ExtensionContext["ui"] | undefined;
	let hasUI = false;
	let revealTimer: ReturnType<typeof setTimeout> | undefined;
	let clearTimer: ReturnType<typeof setTimeout> | undefined;
	let generation = 0;
	const toolArgs = new Map<string, ToolArgs>();

	function clearTimers(): void {
		if (revealTimer) clearTimeout(revealTimer);
		if (clearTimer) clearTimeout(clearTimer);
		revealTimer = undefined;
		clearTimer = undefined;
	}
	function trace(lifecycleEvent: string, before: Snapshot | undefined, transition: Transition, toolName?: string, isError?: boolean, rows?: string[], command?: unknown, toolCallId?: string): void {
		if (!debugEnabled()) return;
		const snapshot = transition?.snapshot;
		const verificationRun = toolCallId === undefined ? undefined : snapshot?.verificationRuns?.find((run) => run.toolCallId === toolCallId);
		// This is deliberately host-side and metadata-only: no prompt, arguments,
		// file content, command text, output, or provider payload is written.
		console.error(JSON.stringify({
			timestamp: new Date().toISOString(), lifecycleEvent, toolName, toolCallId,
			success: isError === undefined ? undefined : !isError,
			bashClassification: toolName === "bash" ? classifyBashCommand(command) : undefined,
			generationId: snapshot?.changeGeneration, verificationRun,
			milestonesBefore: milestoneStates(before), milestonesAfter: milestoneStates(snapshot),
			transitionReason: transition?.reason, renderInvalidateRequested: hasUI,
			widgetRendered: rows !== undefined,
		}));
	}
	function render(lifecycleEvent: string, before: Snapshot | undefined, transition: Transition, toolName?: string, isError?: boolean, command?: unknown, toolCallId?: string): void {
		const rows = monitor.render();
		// A Component receives the real terminal width. This guarantees that every
		// emitted row fits it, rather than letting Pi truncate a long widget line.
		if (hasUI) ui?.setWidget(WIDGET_ID, () => ({
			render: (width: number) => monitor.render(width) ?? [],
			invalidate() { /* monitor state is already current */ },
		}));
		trace(lifecycleEvent, before, transition, toolName, isError, rows, command, toolCallId);
	}
	function scheduleReveal(): void {
		if (revealTimer || !hasUI) return;
		const snapshot = monitor.snapshot();
		if (!snapshot || monitor.shouldRender()) return;
		const wait = Math.max(0, minVisibleMs - (Date.now() - snapshot.startedAt!));
		const expectedGeneration = generation;
		revealTimer = setTimeout(() => {
			revealTimer = undefined;
			if (expectedGeneration !== generation) return;
			const before = monitor.snapshot();
			render("visibility_threshold", before, { reason: "minimum visible duration reached", snapshot: monitor.snapshot() });
		}, wait);
	}
	function reset(nextUI?: ExtensionContext["ui"], nextHasUI = false): void {
		clearTimers();
		generation += 1;
		toolArgs.clear();
		monitor.reset();
		ui = nextUI;
		hasUI = nextHasUI;
	}
	function laterClear(): void {
		if (clearTimer) clearTimeout(clearTimer);
		const expectedGeneration = generation;
		clearTimer = setTimeout(() => {
			clearTimer = undefined;
			if (expectedGeneration === generation && hasUI) ui?.setWidget(WIDGET_ID, undefined);
		}, CLEAR_AFTER_SETTLE_MS);
	}

	pi.on("session_start", (event, ctx) => {
		if (ctx.hasUI) ctx.ui.setWidget(WIDGET_ID, undefined);
		reset(ctx.hasUI ? ctx.ui : undefined, ctx.hasUI);
		trace("session_start", undefined, { reason: `session ${event.reason}`, snapshot: undefined });
	});
	pi.on("before_agent_start", (event) => {
		const before = monitor.snapshot();
		const transition = monitor.begin(event.prompt);
		if (hasUI) ui?.setWidget(WIDGET_ID, undefined);
		render("before_agent_start", before, transition);
	});
	pi.on("agent_start", () => {
		const before = monitor.snapshot();
		render("agent_start", before, monitor.agentStart());
	});
	pi.on("tool_execution_start", (event) => {
		const before = monitor.snapshot();
		toolArgs.set(event.toolCallId, event.args as ToolArgs);
		const transition = monitor.toolStart(event.toolName, event.args as ToolArgs, undefined, event.toolCallId);
		render("tool_execution_start", before, transition, event.toolName, undefined, (event.args as ToolArgs)?.command, event.toolCallId);
		scheduleReveal();
	});
	pi.on("tool_execution_update", (event) => {
		const before = monitor.snapshot();
		const args = toolArgs.get(event.toolCallId);
		const transition = monitor.toolUpdate(event.toolName, event.toolCallId);
		render("tool_execution_update", before, transition, event.toolName, undefined, args?.command, event.toolCallId);
	});
	pi.on("tool_execution_end", (event) => {
		const before = monitor.snapshot();
		const args = toolArgs.get(event.toolCallId);
		const transition = monitor.toolEnd(event.toolName, args, event.isError, undefined, event.toolCallId);
		render("tool_execution_end", before, transition, event.toolName, event.isError, args?.command, event.toolCallId);
		toolArgs.delete(event.toolCallId);
	});
	pi.on("turn_end", (event) => {
		const before = monitor.snapshot();
		render("turn_end", before, monitor.turnEnd((event.message as { stopReason?: string } | undefined)?.stopReason));
	});
	pi.on("agent_end", () => {
		const before = monitor.snapshot();
		render("agent_end", before, monitor.agentEnd());
	});
	pi.on("agent_settled", () => {
		const before = monitor.snapshot();
		render("agent_settled", before, monitor.settle());
		laterClear();
	});
	pi.on("session_shutdown", (event) => {
		const before = monitor.snapshot();
		if (hasUI) ui?.setWidget(WIDGET_ID, undefined);
		trace("session_shutdown", before, { reason: `session ${event.reason}`, snapshot: undefined });
		reset();
	});
}
