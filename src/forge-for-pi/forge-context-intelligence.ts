import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { packPayload } from "./forge-context-intelligence-core.mjs";
import { claimForgeComponent } from "./forge-runtime.mjs";

type Policy = { enabled?: boolean; minimumHistoryTokens?: number };
type ProviderPolicies = Record<string, { default?: Policy; models?: Record<string, Policy> }>;
type ModelIdentity = { provider?: string; id?: string };

/**
 * Provider/model policy surface. The default is provider-neutral; add a provider
 * or model entry here when a verified transport/model needs different behavior.
 */
export const CONTEXT_INTELLIGENCE_POLICIES: { default: Policy; providers: ProviderPolicies } = {
	default: { minimumHistoryTokens: 512 },
	providers: {},
};

function resolveContextIntelligencePolicyForModel(modelIdentity: ModelIdentity | undefined): Policy {
	const provider = modelIdentity?.provider;
	const model = modelIdentity?.id;
	const providerPolicy = provider ? CONTEXT_INTELLIGENCE_POLICIES.providers[provider] : undefined;
	return {
		...CONTEXT_INTELLIGENCE_POLICIES.default,
		...providerPolicy?.default,
		...(model ? providerPolicy?.models?.[model] : undefined),
	};
}

/** Compatibility helper for callers that have a currently-valid event context. */
export function resolveContextIntelligencePolicy(ctx: Pick<ExtensionContext, "model">): Policy {
	return resolveContextIntelligencePolicyForModel(ctx.model);
}

function enabled(): boolean {
	const value = process.env.FORGE_CONTEXT_INTELLIGENCE?.trim().toLowerCase();
	return value !== "0" && value !== "false" && value !== "no" && value !== "off";
}
function accountingEnabled(): boolean {
	const value = process.env.FORGE_CONTEXT_ACCOUNTING?.trim().toLowerCase();
	return value === "1" || value === "true" || value === "yes";
}
function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	return Array.isArray(content) ? content.filter((part): part is { type: string; text?: string } => !!part && typeof part === "object" && part.type === "text").map((part) => part.text ?? "").join("\n") : "";
}
function queryOf(payload: Record<string, unknown>): string {
	const messages = Array.isArray(payload.messages) ? payload.messages : [];
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index] as Record<string, unknown>;
		if (message?.role === "user") return textOf(message.content);
	}
	return "";
}
function runtimeDir(sessionId: string): string {
	const root = process.env.FORGE_CONTEXT_RUNTIME_DIR
		?? join(process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? homedir(), ".pi", "agent"), "context-intelligence");
	return join(resolve(root), sessionId.replace(/[^a-zA-Z0-9_-]/g, "_"));
}
function record(dir: string, accounting: Record<string, unknown>): void {
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		appendFileSync(join(dir, "accounting.jsonl"), `${JSON.stringify({ event: "pack", ...accounting })}\n`, { encoding: "utf8", mode: 0o600 });
	} catch { /* optional accounting is non-fatal */ }
}

/** Host-only Context Intelligence: no tools, skills, commands, or prompt changes. */
export default function contextIntelligence(pi: ExtensionAPI): void {
	if (!claimForgeComponent(pi, "context-intelligence") || !enabled()) return;
	// Keep only primitive session state captured from current lifecycle events.
	// emitContext can finish from a replaced/reloaded runner, where its ctx is stale.
	let sessionId = "unknown";
	let model: ModelIdentity | undefined;
	pi.on("session_start", (_event, ctx) => {
		sessionId = ctx.sessionManager.getSessionId();
		model = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
	});
	pi.on("model_select", (event) => {
		model = { provider: event.model.provider, id: event.model.id };
	});
	// Provider-neutral context interception is required by openai-codex, whose
	// transport payload is not exposed through before_provider_request. Do not
	// read this handler's ctx: an in-flight transform may belong to a stale runner.
	pi.on("context", (event) => {
		const policy = resolveContextIntelligencePolicyForModel(model);
		if (policy.enabled === false) return;
		const payload = { messages: event.messages };
		const dir = runtimeDir(sessionId);
		try {
			const result = packPayload(payload, {
				runtimeDir: dir,
				query: queryOf(payload),
				minimumHistoryTokens: policy.minimumHistoryTokens,
			});
			// A fast bypass returns the original payload and performs no host I/O.
			if (result.payload === payload) return;
			if (accountingEnabled()) record(dir, result.accounting);
			return { messages: result.payload.messages };
		} catch {
			// The provider-neutral context remains untouched if host processing fails.
			return undefined;
		}
	});
}
