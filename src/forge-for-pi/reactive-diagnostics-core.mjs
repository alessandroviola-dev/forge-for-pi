import { spawn } from "node:child_process";
import { extname } from "node:path";

const MAX_DIAGNOSTICS = 5;

export function monitoredTool(name) {
	return name === "edit" || name === "write";
}

export function supportedLanguage(path) {
	return extname(path).toLowerCase() === ".py" ? "python" : undefined;
}

export function parseRuffDiagnostics(stdout) {
	try {
		const rows = JSON.parse(stdout);
		if (!Array.isArray(rows)) return [];
		return rows
			.filter((row) => row && typeof row.code === "string" && typeof row.message === "string" && Number.isInteger(row.location?.row))
			.map((row) => ({
				code: row.code,
				message: row.message.replace(/\s+/g, " ").trim(),
				line: row.location.row,
				column: Number.isInteger(row.location.column) ? row.location.column : 1,
			}));
	} catch {
		return [];
	}
}

function fingerprint(diagnostic) {
	// Ruff diagnostics retain their code/message when unrelated lines shift.
	return `${diagnostic.code}\u0000${diagnostic.message}`;
}

export function introducedDiagnostics(before, after, limit = MAX_DIAGNOSTICS) {
	const old = new Map();
	for (const diagnostic of before) {
		const key = fingerprint(diagnostic);
		old.set(key, (old.get(key) ?? 0) + 1);
	}
	const introduced = [];
	for (const diagnostic of after) {
		const key = fingerprint(diagnostic);
		const count = old.get(key) ?? 0;
		if (count > 0) {
			old.set(key, count - 1);
			continue;
		}
		introduced.push(diagnostic);
		if (introduced.length === limit) break;
	}
	return introduced;
}

export function formatDiagnostics(path, diagnostics) {
	if (diagnostics.length === 0) return "";
	return `New diagnostics:\n${diagnostics.map((diagnostic) => `${path}:${diagnostic.line} ${diagnostic.code} ${diagnostic.message}`).join("\n")}`;
}

function runRuff(path, signal) {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		let child;
		try {
			child = spawn("ruff", ["check", "--isolated", "--select", "E9,F", "--format", "json", path], {
			stdio: ["ignore", "pipe", "ignore"],
			signal,
			windowsHide: true,
			});
		} catch {
			finish({ unavailable: true });
			return;
		}
		const stdout = [];
		child.stdout.on("data", (chunk) => stdout.push(chunk));
		child.once("error", (error) => finish(error && "code" in error && error.code === "ENOENT" ? { unavailable: true } : { unavailable: true }));
		child.once("close", () => finish({ stdout: Buffer.concat(stdout).toString("utf8") }));
	});
}

/**
 * Runs only an already-installed, local diagnostic for the changed file. No
 * language server is launched, installed, or kept alive. The runner is
 * injectable so the policy can be tested without depending on host tooling.
 */
export class ReactiveDiagnostics {
	#run;

	constructor({ run = runRuff } = {}) {
		this.#run = run;
	}

	async captureBefore(path, signal) {
		if (!supportedLanguage(path)) return undefined;
		try {
			const result = await this.#run(path, signal);
			if (!result || result.unavailable || typeof result.stdout !== "string") return undefined;
			return { path, diagnostics: parseRuffDiagnostics(result.stdout) };
		} catch {
			return undefined;
		}
	}

	async diagnosticsAfter(before, signal) {
		if (!before) return [];
		try {
			const result = await this.#run(before.path, signal);
			if (!result || result.unavailable || typeof result.stdout !== "string") return [];
			return introducedDiagnostics(before.diagnostics, parseRuffDiagnostics(result.stdout));
		} catch {
			return [];
		}
	}
}
