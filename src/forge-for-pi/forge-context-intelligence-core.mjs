import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MIN_HISTORY_TOKENS = 512;
const estimateTokens = (text) => Math.ceil(Buffer.byteLength(text, "utf8") / 4);
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

function textOf(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n");
}
function withText(content, text) {
	return typeof content === "string" ? text : [{ type: "text", text }];
}
function redact(text) {
	return text
		.replace(/\bauthorization\s*:\s*bearer\s+[^\s]+/gi, "[REDACTED_CREDENTIAL]")
		.replace(/\b(?:api[_-]?key|token|secret|password)\s*[=:]\s*[^\s]+/gi, "[REDACTED_CREDENTIAL]")
		.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]");
}
function queryTerms(query) {
	return [...new Set((query.toLowerCase().match(/[a-z0-9_./:-]{3,}/g) ?? []).filter((term) => !new Set(["with", "only", "then", "after", "that", "this", "exact", "reply", "read", "tool", "file", "the", "and"]).has(term)))];
}
function compact(text, query, ref) {
	const lines = text.split("\n"); const terms = queryTerms(query);
	const keep = new Set();
	for (let index = 0; index < Math.min(5, lines.length); index += 1) keep.add(index);
	for (let index = Math.max(5, lines.length - 5); index < lines.length; index += 1) keep.add(index);
	for (const [index, line] of lines.entries()) {
		const lower = line.toLowerCase();
		if (/\b(error|warning|fatal|exception|traceback)\b/i.test(line) || terms.some((term) => lower.includes(term))) keep.add(index);
	}
	const selected = [...keep].sort((a, b) => a - b).slice(0, 96);
	const body = selected.map((index) => `${index + 1}: ${lines[index]}`).join("\n");
	return `[Forge Context Intelligence packed tool evidence; exact recovery=${ref}; retained ${selected.length}/${lines.length} lines]\n${body}`;
}
function readMemory(runtimeDir) {
	const path = join(runtimeDir, "memory.jsonl");
	if (!existsSync(path)) return [];
	try { return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; }
}
/** Cavemem-style lexical progressive retrieval: explicit recall + two overlaps. */
export function searchMemory(runtimeDir, query, limit = 3) {
	if (!/\b(recall|recover|previous|earlier|decision|benchmark|constraint|rollback)\b/i.test(query)) return [];
	const terms = new Set(queryTerms(query));
	return readMemory(runtimeDir)
		.map((row) => ({ row, overlaps: (row.keywords ?? []).filter((word) => terms.has(String(word).toLowerCase())).length }))
		.filter((candidate) => candidate.overlaps >= 2)
		.sort((a, b) => b.overlaps - a.overlaps || String(a.row.id).localeCompare(String(b.row.id)))
		.slice(0, limit).map((candidate) => candidate.row);
}
function persist(runtimeDir, original) {
	const redacted = redact(original); const hash = sha256(redacted); const artifacts = join(runtimeDir, "artifacts");
	mkdirSync(artifacts, { recursive: true, mode: 0o700 });
	const artifact = join(artifacts, `${hash}.txt`);
	if (!existsSync(artifact)) writeFileSync(artifact, redacted, { encoding: "utf8", mode: 0o600 });
	const ref = `forgeci://artifact/${hash}`;
	const memoryPath = join(runtimeDir, "memory.jsonl");
	if (!readMemory(runtimeDir).some((row) => row.hash === hash)) {
		appendFileSync(memoryPath, `${JSON.stringify({ id: hash.slice(0, 16), hash, ref, tokens: estimateTokens(redacted), keywords: queryTerms(redacted).filter((term) => /[a-z]/i.test(term)).slice(0, 24), privacy: redacted === original ? "clean" : "redacted" })}\n`, { encoding: "utf8", mode: 0o600 });
	}
	return { ref, hash, redacted };
}

/** Exact, hash-verified local recovery; intentionally host-only (not a Pi tool). */
export function recover(runtimeDir, ref) {
	const match = /^forgeci:\/\/artifact\/([a-f0-9]{64})$/.exec(ref);
	if (!match) return { ok: false, reason: "invalid-ref" };
	try {
		const text = readFileSync(join(runtimeDir, "artifacts", `${match[1]}.txt`), "utf8");
		return { ok: sha256(text) === match[1], text, hash: match[1] };
	} catch { return { ok: false, reason: "missing-artifact" }; }
}

/**
 * Caveman/Cavemem-derived, deterministic, fail-open payload preparation.
 * Current user text and protocol fields are never rewritten. Only large prior
 * textual tool evidence is packed, and only when doing so saves material context.
 */
export function packPayload(payload, { runtimeDir, query = "", minimumHistoryTokens = MIN_HISTORY_TOKENS } = {}) {
	const started = performance.now();
	const base = { processed: true, bypassed: true, tokensBefore: 0, tokensAfter: 0, tokensRemoved: 0, retrievedTokens: 0, reinsertedTokens: 0, selected: 0, deferred: 0, recoveryRefs: [], recoveryVerified: true };
	if (!payload || !Array.isArray(payload.messages) || !runtimeDir) return { payload, accounting: { ...base, reason: "invalid-or-unconfigured", wallDurationMs: Math.round((performance.now() - started) * 1000) / 1000 } };
	const messages = payload.messages;
	const historical = messages.filter((message) => message?.role === "tool" || message?.role === "toolResult");
	const historicalTokens = historical.reduce((total, message) => total + estimateTokens(textOf(message.content)), 0);
	base.tokensBefore = historicalTokens;
	// This identity path performs no memory lookup, artifact persistence, payload copy, or accounting I/O.
	if (historicalTokens < minimumHistoryTokens) return { payload, accounting: { ...base, reason: "small-history", wallDurationMs: Math.round((performance.now() - started) * 1000) / 1000 } };
	const recalledHashes = new Set(searchMemory(runtimeDir, query).map((row) => row.hash));
	const next = { ...payload, messages: messages.map((message) => ({ ...message, ...(Array.isArray(message?.content) ? { content: [...message.content] } : {}) })) };
	for (const message of next.messages) {
		if (message?.role !== "tool" && message?.role !== "toolResult") continue;
		const original = textOf(message.content);
		if (estimateTokens(original) < minimumHistoryTokens) continue;
		const knownBeforePack = recalledHashes.has(sha256(redact(original)));
		const stored = persist(runtimeDir, original);
		const recovered = knownBeforePack ? recover(runtimeDir, stored.ref) : { ok: true, text: stored.redacted };
		const source = recovered.ok ? recovered.text : stored.redacted;
		const packed = compact(source, query, stored.ref);
		if (estimateTokens(packed) >= estimateTokens(original) * 0.85) continue;
		message.content = withText(message.content, packed);
		base.selected += 1; base.recoveryRefs.push(stored.ref); base.recoveryVerified &&= recovered.ok;
		if (knownBeforePack && recovered.ok) { base.retrievedTokens += estimateTokens(source); base.reinsertedTokens += estimateTokens(packed); }
		base.tokensRemoved += estimateTokens(original) - estimateTokens(packed);
	}
	base.tokensAfter = historicalTokens - base.tokensRemoved;
	base.deferred = historical.length - base.selected;
	base.bypassed = base.selected === 0;
	return { payload: base.bypassed ? payload : next, accounting: { ...base, reason: base.bypassed ? "no-material-saving" : "packed", wallDurationMs: Math.round((performance.now() - started) * 1000) / 1000 } };
}
