import { createHash } from "node:crypto";

export const SNAPSHOT_PREFIX = "sha256:";
const SMART_READ_PREFIX = "[Smart read structural view:";

export class SnapshotEditError extends Error {
	constructor(code, message, snapshot) {
		super(message);
		this.name = "SnapshotEditError";
		this.code = code;
		this.snapshot = snapshot;
	}
}

export function hashContent(content) {
	return `${SNAPSHOT_PREFIX}${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

function splitBom(content) {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

function normalizeToLF(content) {
	return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function detectLineEnding(content) {
	const crlf = content.indexOf("\r\n");
	const lf = content.indexOf("\n");
	return crlf !== -1 && (lf === -1 || crlf < lf) ? "\r\n" : "\n";
}

function restoreLineEndings(content, ending) {
	return ending === "\r\n" ? content.replace(/\n/g, "\r\n") : content;
}

function lineStart(content, line) {
	if (line <= 1) return 0;
	let start = 0;
	for (let index = 1; index < line; index += 1) {
		const newline = content.indexOf("\n", start);
		if (newline === -1) return content.length;
		start = newline + 1;
	}
	return start;
}

function selectedContent(content, offset, limit) {
	const lines = content.split("\n");
	const startLine = offset === undefined ? 1 : Math.max(1, offset);
	const start = lineStart(content, startLine);
	if (start >= content.length && !(content === "" && startLine === 1)) return undefined;
	const selected = limit === undefined ? content.slice(start) : lines.slice(startLine - 1, startLine - 1 + limit).join("\n");
	return { start, selected };
}

function visibleText(resultText) {
	// Native read adds only these terminal continuation notices. They are not file text.
	const marker = resultText.search(/\n\n\[(?:Showing lines \d+-\d+ of \d+|\d+ more lines in file\.)/);
	return marker === -1 ? resultText : resultText.slice(0, marker);
}

function mergeRanges(ranges) {
	const ordered = ranges
		.filter((range) => range.end > range.start)
		.sort((a, b) => a.start - b.start || a.end - b.end);
	const merged = [];
	for (const range of ordered) {
		const previous = merged[merged.length - 1];
		if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
		else merged.push({ ...range });
	}
	return merged;
}

function rangeContains(ranges, start, end) {
	return ranges.some((range) => range.start <= start && end <= range.end);
}

function countMatches(content, text) {
	const matches = [];
	for (let start = 0; ;) {
		const index = content.indexOf(text, start);
		if (index === -1) return matches;
		matches.push(index);
		start = index + Math.max(1, text.length);
	}
}

function lineRange(content, start, end) {
	const startLine = content.slice(0, start).split("\n").length;
	const endLine = content.slice(0, Math.max(start, end - 1)).split("\n").length;
	return { startLine, limit: Math.max(1, endLine - startLine + 1) };
}

function transformRanges(ranges, replacements) {
	const output = ranges.map((range) => ({ ...range }));
	let shift = 0;
	for (const replacement of replacements) {
		const start = replacement.start + shift;
		const end = start + replacement.oldText.length;
		const delta = replacement.newText.length - replacement.oldText.length;
		for (const range of output) {
			if (range.end <= start) continue;
			if (range.start >= end) {
				range.start += delta;
				range.end += delta;
				continue;
			}
			range.start = Math.min(range.start, start);
			range.end = Math.max(start + replacement.newText.length, range.end + delta);
		}
		shift += delta;
	}
	return mergeRanges(output);
}

function snapshotFor(rawContent) {
	const { bom, text } = splitBom(rawContent);
	return { hash: hashContent(rawContent), rawContent, normalized: normalizeToLF(text), bom, ranges: [], seenHashes: [] };
}

/**
 * `scope: "full"` is retained solely for the Phase 3 benchmark control. The
 * production default validates the edit's observed target rather than the
 * unrelated bytes of the file.
 */
export class SnapshotEditStore {
	#snapshots = new Map();
	#scope;

	constructor({ scope = "scoped" } = {}) {
		this.#scope = scope;
	}

	get(path) {
		const snapshot = this.#snapshots.get(path);
		return snapshot && {
			...snapshot,
			ranges: snapshot.ranges.map((range) => ({ ...range })),
			seenHashes: [...snapshot.seenHashes],
		};
	}

	captureRead(path, rawContent, params, resultText) {
		const snapshot = snapshotFor(rawContent);
		const selected = selectedContent(snapshot.normalized, params.offset, params.limit);
		if (!resultText.startsWith(SMART_READ_PREFIX) && selected) {
			const visible = normalizeToLF(visibleText(resultText.startsWith("\uFEFF") ? resultText.slice(1) : resultText));
			if (visible.length > 0 && selected.selected.startsWith(visible)) {
				snapshot.ranges.push({ start: selected.start, end: selected.start + visible.length });
				snapshot.seenHashes.push(hashContent(visible));
			}
		}
		const previous = this.#snapshots.get(path);
		if (previous?.hash === snapshot.hash) {
			snapshot.ranges = mergeRanges([...previous.ranges, ...snapshot.ranges]);
			snapshot.seenHashes = [...previous.seenHashes, ...snapshot.seenHashes];
		}
		this.#snapshots.set(path, snapshot);
		return this.get(path);
	}

	refreshStale(path, rawContent) {
		const snapshot = snapshotFor(rawContent);
		this.#snapshots.set(path, snapshot);
		return snapshot;
	}

	#stale(path, currentRaw) {
		const fresh = this.refreshStale(path, currentRaw);
		throw new SnapshotEditError("STALE", `Stale edit: the observed target changed, is missing, or is ambiguous; read it again. snapshot=${fresh.hash}`, fresh);
	}

	planEdit(path, edits, currentRaw) {
		if (!Array.isArray(edits) || edits.length === 0) throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
		if (edits.some((edit) => edit.oldText === edit.newText)) {
			throw new SnapshotEditError("NO_OP", `No changes made to ${path}. The replacement produced identical content.`);
		}
		const snapshot = this.#snapshots.get(path);
		if (!snapshot) throw new SnapshotEditError("UNSEEN", `Unseen edit target in ${path}; read it first.`);
		const current = snapshotFor(currentRaw);
		const wasGloballyChanged = current.hash !== snapshot.hash;
		if (wasGloballyChanged && this.#scope === "full") this.#stale(path, currentRaw);

		const normalizedEdits = edits.map((edit, index) => {
			if (typeof edit?.oldText !== "string" || typeof edit?.newText !== "string") throw new Error(`Invalid edits[${index}] in ${path}.`);
			const oldText = normalizeToLF(edit.oldText);
			if (oldText.length === 0) throw new Error(`edits[${index}].oldText must not be empty in ${path}.`);
			return { oldText, newText: normalizeToLF(edit.newText), index };
		});
		const replacements = normalizedEdits.map((edit) => {
			// Establish that this exact target was actually seen in the snapshot.
			const observedMatches = countMatches(snapshot.normalized, edit.oldText);
			if (observedMatches.length === 0) throw new Error(`Could not find edits[${edit.index}] in ${path}. The oldText must match exactly including all whitespace and newlines.`);
			if (observedMatches.length > 1) throw new Error(`Found ${observedMatches.length} occurrences of edits[${edit.index}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`);
			const observedStart = observedMatches[0];
			const observedEnd = observedStart + edit.oldText.length;
			if (!rangeContains(snapshot.ranges, observedStart, observedEnd)) {
				const range = lineRange(snapshot.normalized, observedStart, observedEnd);
				throw new SnapshotEditError("UNSEEN", `Unseen edit target; read offset=${range.startLine} limit=${range.limit} first. snapshot=${snapshot.hash}`, snapshot);
			}

			// A changed file is safe only if this observed edit region still exists
			// exactly once. This intentionally ignores unrelated concurrent bytes.
			const currentMatches = countMatches(current.normalized, edit.oldText);
			if (currentMatches.length !== 1) {
				if (wasGloballyChanged) this.#stale(path, currentRaw);
				if (currentMatches.length === 0) throw new Error(`Could not find edits[${edit.index}] in ${path}. The oldText must match exactly including all whitespace and newlines.`);
				throw new Error(`Found ${currentMatches.length} occurrences of edits[${edit.index}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`);
			}
			const start = currentMatches[0];
			return { ...edit, start, end: start + edit.oldText.length, observedStart, regionHash: hashContent(edit.oldText) };
		}).sort((a, b) => a.start - b.start);
		for (let index = 1; index < replacements.length; index += 1) {
			if (replacements[index - 1].end > replacements[index].start) throw new Error(`edits[${replacements[index - 1].index}] and edits[${replacements[index].index}] overlap in ${path}. Merge them into one edit or target disjoint regions.`);
		}
		let next = current.normalized;
		for (let index = replacements.length - 1; index >= 0; index -= 1) {
			const replacement = replacements[index];
			next = next.slice(0, replacement.start) + replacement.newText + next.slice(replacement.end);
		}
		if (next === current.normalized) throw new SnapshotEditError("NO_OP", `No changes made to ${path}. The replacements produced identical content.`);
		return {
			finalRaw: current.bom + restoreLineEndings(next, detectLineEnding(splitBom(currentRaw).text)),
			normalized: next,
			baseNormalized: current.normalized,
			replacements,
			snapshot,
			expectedHash: current.hash,
			wasGloballyChanged,
		};
	}

	commit(path, plan) {
		const final = snapshotFor(plan.finalRaw);
		final.ranges = plan.wasGloballyChanged
			? mergeRanges(plan.replacements.map((replacement) => ({ start: replacement.start, end: replacement.start + replacement.newText.length })))
			: transformRanges(plan.snapshot.ranges, plan.replacements);
		final.seenHashes = plan.replacements.map((replacement) => hashContent(replacement.newText));
		this.#snapshots.set(path, final);
		return this.get(path);
	}
}
