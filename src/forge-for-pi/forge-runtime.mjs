const CLAIMS_KEY = Symbol.for("forge-for-pi.runtime.claims");

/** Forge is opt-in; plain Pi never loads behaviour from this candidate. */
export function forgeEnabled() {
	return process.env.FORGE_FOR_PI === "1";
}

/** Keep global and project discovery from registering a component twice. */
export function claimForgeComponent(pi, component) {
	if (!forgeEnabled()) return false;
	const carrier = pi;
	let claims = carrier[CLAIMS_KEY];
	if (!claims) {
		claims = new Set();
		carrier[CLAIMS_KEY] = claims;
	}
	if (claims.has(component)) return false;
	claims.add(component);
	return true;
}
