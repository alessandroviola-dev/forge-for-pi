import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { claimForgeComponent } from "./forge-runtime.mjs";

type RecordValue = Record<string, unknown>;

function enabled(): boolean {
	const value = process.env.FORGE_FOR_PI_TRACE?.toLowerCase();
	return value === "1" || value === "true" || value === "yes";
}

function record(value: unknown): RecordValue | undefined {
	return value !== null && typeof value === "object" ? (value as RecordValue) : undefined;
}

function string(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function number(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function usageFields(message: unknown): RecordValue {
	const usage = record(record(message)?.usage);
	const cost = record(usage?.cost);
	return {
		...(number(usage?.input) === undefined ? {} : { inputTokens: number(usage?.input) }),
		...(number(usage?.output) === undefined ? {} : { outputTokens: number(usage?.output) }),
		...(number(usage?.cacheRead) === undefined ? {} : { cacheReadTokens: number(usage?.cacheRead) }),
		...(number(usage?.cacheWrite) === undefined ? {} : { cacheWriteTokens: number(usage?.cacheWrite) }),
		...(number(cost?.total) === undefined ? {} : { cost: number(cost?.total) }),
	};
}

function outputBytes(result: unknown): number {
	const content = record(result)?.content;
	if (!Array.isArray(content)) return 0;
	return content.reduce((total, block) => {
		const value = record(block);
		// Count only byte lengths; no content is retained or serialized.
		const text = string(value?.text) ?? string(value?.data) ?? "";
		return total + Buffer.byteLength(text);
	}, 0);
}

function identity(ctx: ExtensionContext, message?: unknown): RecordValue {
	const source = record(message);
	const provider = string(source?.provider) ?? ctx.model?.provider;
	const model = string(source?.model) ?? ctx.model?.id;
	return {
		sessionId: ctx.sessionManager.getSessionId(),
		...(provider === undefined ? {} : { provider }),
		...(model === undefined ? {} : { model }),
		...(ctx.thinkingLevel === undefined ? {} : { thinkingLevel: ctx.thinkingLevel }),
	};
}

export default function telemetry(pi: ExtensionAPI): void {
	// Disabled means no hooks, filesystem access, model-visible registration, or prompt changes.
	if (!claimForgeComponent(pi, "telemetry") || !enabled()) return;

	const traceDir = join(process.env.HOME ?? homedir(), ".pi", "agent", "forge-traces");
	const turnStarted = new Map<string, number>();
	const toolStarted = new Map<string, number>();
	let agentRun = 0;
	let retryAttempt = 0;
	let writes = Promise.resolve();

	function turnId(ctx: ExtensionContext, turnIndex: number): string {
		return `${ctx.sessionManager.getSessionId()}:${agentRun}:${turnIndex}`;
	}

	function write(ctx: ExtensionContext, event: RecordValue): void {
		const sessionId = ctx.sessionManager.getSessionId().replace(/[^a-zA-Z0-9_-]/g, "_");
		const line = `${JSON.stringify(event)}\n`;
		writes = writes
			.then(async () => {
				await mkdir(traceDir, { recursive: true, mode: 0o700 });
				await appendFile(join(traceDir, `${sessionId}.jsonl`), line, { encoding: "utf8", mode: 0o600 });
			})
			.catch(() => undefined); // Telemetry must never affect Pi's execution.
	}

	pi.on("agent_start", () => {
		agentRun += 1;
	});

	pi.on("agent_settled", () => {
		retryAttempt = 0;
	});

	pi.on("turn_start", (event, ctx) => {
		turnStarted.set(turnId(ctx, event.turnIndex), event.timestamp);
	});

	pi.on("tool_execution_start", (event) => {
		toolStarted.set(event.toolCallId, Date.now());
	});

	pi.on("tool_execution_end", (event, ctx) => {
		const now = Date.now();
		const started = toolStarted.get(event.toolCallId) ?? now;
		toolStarted.delete(event.toolCallId);
		write(ctx, {
			event: "tool",
			timestamp: new Date(now).toISOString(),
			...identity(ctx),
			toolName: event.toolName,
			durationMs: Math.max(0, now - started),
			success: !event.isError,
			error: event.isError,
			outputBytes: outputBytes(event.result),
		});
	});

	pi.on("turn_end", (event, ctx) => {
		const now = Date.now();
		const id = turnId(ctx, event.turnIndex);
		const started = turnStarted.get(id) ?? now;
		turnStarted.delete(id);
		const message = record(event.message);
		const stopReason = string(message?.stopReason);
		const isError = stopReason === "error";
		if (isError) retryAttempt += 1;
		write(ctx, {
			event: "turn",
			timestamp: new Date(now).toISOString(),
			...identity(ctx, event.message),
			turnId: id,
			...usageFields(event.message),
			stopReason,
			success: stopReason === "stop" || stopReason === "toolUse",
			error: isError,
			retryAttempt,
			durationMs: Math.max(0, now - started),
		});
		if (!isError) retryAttempt = 0;
	});
}
