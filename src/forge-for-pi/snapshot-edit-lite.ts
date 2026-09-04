import { randomUUID } from "node:crypto";
import { open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
	createEditToolDefinition,
	generateDiffString,
	generateUnifiedPatch,
	type ExtensionAPI,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { SnapshotEditError, SnapshotEditStore, hashContent } from "./snapshot-edit-lite-core.mjs";
import { claimForgeComponent } from "./forge-runtime.mjs";

type ReadParams = { path?: unknown; offset?: unknown; limit?: unknown };
type PendingRead = { path: string; rawContent: string; params: { offset?: number; limit?: number } };

function normalizePath(cwd: string, path: string): string {
	const value = path.replace(/^@/, "");
	return resolve(value.startsWith("~/") ? `${process.env.HOME ?? ""}/${value.slice(2)}` : cwd, value.startsWith("~/") ? "." : value);
}

async function canonicalPath(path: string): Promise<string> {
	try { return await realpath(path); } catch { return path; }
}

function textContent(content: unknown): string | undefined {
	if (!Array.isArray(content)) return undefined;
	const text = content.find((block) => block !== null && typeof block === "object" && (block as { type?: unknown }).type === "text") as { text?: unknown } | undefined;
	return typeof text?.text === "string" ? text.text : undefined;
}

async function writeAtomically(path: string, content: string, expectedHash: string): Promise<void> {
	// The second read closes the observable stale window before the atomic rename.
	// Pi's mutation queue serializes Pi writers; this detects an external writer
	// that arrived while the edit was being prepared.
	if (hashContent(await readFile(path, "utf8")) !== expectedHash) throw new Error("concurrent file change");
	const info = await stat(path);
	const temporary = resolve(dirname(path), `.${process.pid}.${randomUUID()}.pi-edit-tmp`);
	try {
		const handle = await open(temporary, "wx", info.mode & 0o777);
		try {
			await handle.writeFile(content, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporary, path); // Atomic replacement on the target filesystem.
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => undefined);
		throw error;
	}
}

export default function snapshotEditLite(pi: ExtensionAPI): void {
	if (!claimForgeComponent(pi, "snapshot-edit-lite")) return;
	// `full` is used only by the reproducible Phase 3 control benchmark.
	const snapshots = new SnapshotEditStore({ scope: process.env.FORGE_FOR_PI_SNAPSHOT_SCOPE === "full" ? "full" : "scoped" });
	const pendingReads = new Map<string, PendingRead>();

	// This observes read lifecycle events only; it neither replaces nor changes read.
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "read") return;
		const params = event.input as ReadParams;
		if (typeof params.path !== "string") return;
		try {
			const path = await canonicalPath(normalizePath(ctx.cwd, params.path));
			const rawContent = await readFile(path, "utf8");
			pendingReads.set(event.toolCallId, {
				path,
				rawContent,
				params: {
					...(typeof params.offset === "number" ? { offset: params.offset } : {}),
					...(typeof params.limit === "number" ? { limit: params.limit } : {}),
				},
			});
		} catch {
			// Native read retains ownership of unreadable, binary, image, and path errors.
		}
	});

	pi.on("tool_result", (event) => {
		if (event.toolName !== "read") return;
		const pending = pendingReads.get(event.toolCallId);
		pendingReads.delete(event.toolCallId);
		const result = textContent(event.content);
		if (!pending || event.isError || result === undefined) return;
		snapshots.captureRead(pending.path, pending.rawContent, pending.params, result);
	});

	const builtin = createEditToolDefinition(process.cwd());
	pi.registerTool({
		...builtin,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const path = params.path;
			const absolutePath = await canonicalPath(normalizePath(ctx.cwd, path));
			return withFileMutationQueue(absolutePath, async () => {
				if (signal?.aborted) throw new Error("Operation aborted");
				let current: string;
				try {
					current = await readFile(absolutePath, "utf8");
				} catch (error) {
					const code = error instanceof Error && "code" in error ? ` Error code: ${error.code}.` : "";
					throw new Error(`Could not edit file: ${path}.${code}`);
				}
				let plan;
				try {
					plan = snapshots.planEdit(absolutePath, params.edits, current);
					if (signal?.aborted) throw new Error("Operation aborted");
					await writeAtomically(absolutePath, plan.finalRaw, plan.expectedHash);
				} catch (error) {
					if (error instanceof SnapshotEditError) throw error;
					if (error instanceof Error && error.message === "concurrent file change") {
						const fresh = await readFile(absolutePath, "utf8");
						const snapshot = snapshots.refreshStale(absolutePath, fresh);
						throw new SnapshotEditError("STALE", `Stale edit: file changed; read it again. snapshot=${snapshot.hash}`, snapshot);
					}
					throw error;
				}
				if (signal?.aborted) throw new Error("Operation aborted");
				const diff = generateDiffString(plan.baseNormalized, plan.normalized);
				snapshots.commit(absolutePath, plan);
				return {
					content: [{ type: "text", text: `Successfully replaced ${params.edits.length} block(s) in ${path}.` }],
					details: {
						diff: diff.diff,
						patch: generateUnifiedPatch(path, plan.baseNormalized, plan.normalized),
						firstChangedLine: diff.firstChangedLine,
					},
				};
			});
		},
	});
}
