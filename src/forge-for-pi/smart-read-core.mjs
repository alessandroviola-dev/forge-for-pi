import { extname } from "node:path";

export const VANILLA_MAX_BYTES = 50 * 1024;
const MAX_SYMBOLS = 80;
const MAX_LINE_BYTES = 360;
const SOURCE_EXTENSIONS = new Set([
	".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs",
	".py", ".java", ".go", ".rs", ".c", ".h", ".cc", ".cpp", ".hpp",
	".cs", ".php", ".rb", ".swift", ".kt", ".kts", ".scala", ".md", ".mdx",
]);

export function isSmartReadCandidate(path, offset, limit, size, buffer) {
	if (offset !== undefined || limit !== undefined || size <= VANILLA_MAX_BYTES || !SOURCE_EXTENSIONS.has(extname(path).toLowerCase())) return false;
	if (buffer.includes(0)) return false;
	const text = buffer.toString("utf8");
	return text.length === 0 || (text.match(/\uFFFD/g)?.length ?? 0) / text.length < 0.001;
}

function shortLine(line) {
	const text = line.trim().replace(/\s+/g, " ");
	if (Buffer.byteLength(text) <= MAX_LINE_BYTES) return text;
	return `${Buffer.from(text).subarray(0, MAX_LINE_BYTES - 3).toString("utf8")}...`;
}

function collectSymbols(lines, extension) {
	const found = [];
	const markdown = extension === ".md" || extension === ".mdx";
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#")) {
			if (markdown && /^#{1,6}\s+\S/.test(trimmed)) found.push({ line: index + 1, text: shortLine(line) });
			continue;
		}
		const declaration =
			/^(?:import|export)\s/.test(trimmed) ||
			/^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:class|interface|type|enum|namespace|module)\s+/.test(trimmed) ||
			/^(?:export\s+)?(?:declare\s+)?(?:async\s+)?function\s+/.test(trimmed) ||
			/^(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*(?::[^=;]+)?=\s*(?:async\s*)?\(?[^=]*=>/.test(trimmed) ||
			/^(?:public|private|protected|internal|static|async|readonly|override|final|virtual|sealed|open|\s)*(?:constructor|[A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\([^)]*\)\s*(?::\s*[^={]+)?\s*[{=]/.test(trimmed) ||
			/^(?:def|class|async\s+def)\s+[A-Za-z_][\w]*/.test(trimmed) ||
			/^(?:func|type|var|const|package)\s+[A-Za-z_][\w]*/.test(trimmed) ||
			/^(?:pub(?:\([^)]*\))?\s+)?(?:fn|struct|enum|trait|impl)\s+/.test(trimmed) ||
			/^(?:public|private|protected|internal)?\s*(?:class|interface|enum|record|void|[A-Za-z_$][\w$<>\[\], ?]*)\s+[A-Za-z_$][\w$]*\s*\([^;]*\)\s*[{;]/.test(trimmed);
		if (declaration) found.push({ line: index + 1, text: shortLine(line) });
	}
	return found;
}

function sampleSymbols(symbols) {
	if (symbols.length <= MAX_SYMBOLS) return symbols;
	const selected = [];
	for (let index = 0; index < MAX_SYMBOLS; index += 1) selected.push(symbols[Math.round(index * (symbols.length - 1) / (MAX_SYMBOLS - 1))]);
	return selected.filter((symbol, index) => index === 0 || symbol.line !== selected[index - 1].line);
}

function rangeNotice(start, end) {
	return `[omitted lines ${start}-${end}; exact: read with offset=${start}, limit=${end - start + 1}]`;
}

export function buildStructuralView(path, text) {
	const lines = text.split("\n");
	const symbols = collectSymbols(lines, extname(path).toLowerCase());
	if (symbols.length === 0) return undefined;
	const selected = sampleSymbols(symbols);
	const output = [
		`[Smart read structural view: ${lines.length} lines; ${symbols.length} declarations/headings detected.]`,
		`[Exact content is always available with read path=${path} offset=<line> limit=<lines>.]`,
	];
	let previous = 0;
	for (const symbol of selected) {
		if (symbol.line > previous + 1) output.push(rangeNotice(previous + 1, symbol.line - 1));
		output.push(`${symbol.line}: ${symbol.text}`);
		previous = symbol.line;
	}
	if (previous < lines.length) output.push(rangeNotice(previous + 1, lines.length));
	if (selected.length < symbols.length) output.push(`[${symbols.length - selected.length} additional declarations omitted from this compact view; use the exact ranges above.]`);
	return output.join("\n");
}
