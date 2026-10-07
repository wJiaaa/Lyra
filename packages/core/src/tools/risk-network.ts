/**
 * Network reads use the same policy for public, private and local destinations.
 * Only transport validation and requests that change remote data need a verdict.
 */

import { riskReason, type RiskCode, type RiskParams } from "./risk-reasons.ts";

/** The code lets approval cards translate the rule; the reason is for logs and tool results. */
export type NetworkVerdict =
	| { decision: "allow" }
	| { decision: "refuse"; reason: string; code: RiskCode; params?: RiskParams }
	| { decision: "ask"; reason: string; code: RiskCode; params?: RiskParams };

function refuse(code: RiskCode, params?: RiskParams): NetworkVerdict {
	return { decision: "refuse", reason: riskReason(code, params), code, ...(params ? { params } : {}) };
}

function ask(code: RiskCode, params?: RiskParams): NetworkVerdict {
	return { decision: "ask", reason: riskReason(code, params), code, ...(params ? { params } : {}) };
}

/** Methods that only read. Anything else changes something at the other end. */
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface NetworkRequest {
	url: string;
	/** Defaults to GET, which is what a fetch without one does. */
	method?: string;
}

export function assessNetwork(request: NetworkRequest): NetworkVerdict {
	let url: URL;
	try {
		url = new URL(request.url.trim());
	} catch {
		return refuse("unparsable-url");
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return refuse("unsupported-protocol", { protocol: url.protocol });
	}
	if (url.username || url.password) {
		return refuse("credentials-in-url");
	}

	const method = (request.method ?? "GET").toUpperCase();
	if (!READ_METHODS.has(method)) return ask("method-writes", { method });
	return { decision: "allow" };
}
