import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import contextIntelligence from "./forge-context-intelligence.ts";
import telemetry from "./forge-telemetry.ts";
import reactiveDiagnostics from "./reactive-diagnostics.ts";
import smartRead from "./smart-read.ts";
import snapshotEditLite from "./snapshot-edit-lite.ts";
import taskProgressMonitor from "./task-progress-monitor.ts";
import { forgeEnabled } from "./forge-runtime.mjs";

const GLOBAL_SMART_READ = realpathSync(join(dirname(fileURLToPath(import.meta.url)), "smart-read.ts"));

function usesProjectLocalModules() {
	let directory = resolve(process.cwd());
	while (true) {
		const candidate = join(directory, ".pi", "extensions", "smart-read.ts");
		if (existsSync(candidate)) {
			try { if (realpathSync(candidate) === GLOBAL_SMART_READ) return true; } catch { /* keep walking */ }
		}
		const parent = dirname(directory);
		if (parent === directory) return false;
		directory = parent;
	}
}

/** Forge candidate entrypoint. It exposes only the four existing Pi tools. */
export default function forgeForPi(pi: ExtensionAPI): void {
	if (!forgeEnabled()) return;
	pi.on("session_start", () => {
		pi.setActiveTools(["read", "bash", "edit", "write"]);
	});
	// The monitor is host/TUI-only: no registration, prompt mutation, or return
	// value can reach a model request.
	taskProgressMonitor(pi);
	contextIntelligence(pi);
	if (usesProjectLocalModules()) return;
	telemetry(pi);
	smartRead(pi);
	snapshotEditLite(pi);
	reactiveDiagnostics(pi);
}
