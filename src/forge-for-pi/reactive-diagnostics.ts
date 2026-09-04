import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatDiagnostics, monitoredTool, ReactiveDiagnostics } from "./reactive-diagnostics-core.mjs";
import { claimForgeComponent } from "./forge-runtime.mjs";

type PathInput = { path?: unknown };
type PendingDiagnostic = { path: string; displayPath: string; before: Awaited<ReturnType<ReactiveDiagnostics["captureBefore"]>> };

function normalizePath(cwd: string, path: string): string {
	const value = path.replace(/^@/, "");
	return resolve(value.startsWith("~/") ? `${process.env.HOME ?? ""}/${value.slice(2)}` : cwd, value.startsWith("~/") ? "." : value);
}

async function canonicalPath(path: string): Promise<string> {
	try { return await realpath(path); } catch { return path; }
}

/** Passive post-write diagnostics. It does not register or override any tool. */
export default function reactiveDiagnostics(pi: ExtensionAPI): void {
	if (!claimForgeComponent(pi, "reactive-diagnostics")) return;
	const diagnostics = new ReactiveDiagnostics();
	const pending = new Map<string, PendingDiagnostic>();

	pi.on("tool_call", async (event, ctx) => {
		if (!monitoredTool(event.toolName)) return;
		const input = event.input as PathInput;
		if (typeof input.path !== "string") return;
		const absolutePath = await canonicalPath(normalizePath(ctx.cwd, input.path));
		const before = await diagnostics.captureBefore(absolutePath, ctx.signal);
		if (before) pending.set(event.toolCallId, { path: absolutePath, displayPath: input.path, before });
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!monitoredTool(event.toolName)) return;
		const pendingDiagnostic = pending.get(event.toolCallId);
		pending.delete(event.toolCallId);
		if (!pendingDiagnostic || event.isError) return;
		const introduced = await diagnostics.diagnosticsAfter(pendingDiagnostic.before, ctx.signal);
		const text = formatDiagnostics(pendingDiagnostic.displayPath, introduced);
		if (!text) return;
		return { content: [...event.content, { type: "text", text }] };
	});
}
