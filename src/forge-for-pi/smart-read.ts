import { createReadToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { buildStructuralView, isSmartReadCandidate } from "./smart-read-core.mjs";
import { claimForgeComponent } from "./forge-runtime.mjs";

export default function smartRead(pi: ExtensionAPI): void {
	if (!claimForgeComponent(pi, "smart-read")) return;
	// Spread the actual built-in definition so schema, prompt metadata, renderers,
	// and vanilla execution are retained. This replaces the existing `read` slot;
	// it does not register another model-facing tool.
	const builtin = createReadToolDefinition(process.cwd());
	pi.registerTool({
		...builtin,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const vanilla = createReadToolDefinition(ctx.cwd);
			if (params.offset !== undefined || params.limit !== undefined) {
				return vanilla.execute(toolCallId, params, signal, onUpdate, ctx);
			}
			const absolutePath = resolve(ctx.cwd, params.path.replace(/^@/, ""));
			try {
				const info = await stat(absolutePath);
				if (!info.isFile() || info.size <= 50 * 1024) return vanilla.execute(toolCallId, params, signal, onUpdate, ctx);
				const buffer = await readFile(absolutePath);
				if (!isSmartReadCandidate(absolutePath, params.offset, params.limit, info.size, buffer)) return vanilla.execute(toolCallId, params, signal, onUpdate, ctx);
				const view = buildStructuralView(params.path, buffer.toString("utf8"));
				if (!view) return vanilla.execute(toolCallId, params, signal, onUpdate, ctx);
				return { content: [{ type: "text", text: view }], details: undefined };
			} catch {
				// Keep Pi's native error/path/image behavior for unreadable or unusual files.
				return vanilla.execute(toolCallId, params, signal, onUpdate, ctx);
			}
		},
	});
}
