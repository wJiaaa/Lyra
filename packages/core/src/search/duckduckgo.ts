/**
 * Search with nothing configured.
 *
 * Every other provider needs an account and a key, which means a fresh install has no search at
 * all until somebody goes and gets one. This one works immediately, by asking DuckDuckGo's
 * no-JavaScript HTML endpoint the way a browser without scripting would, and reading the results
 * out of the markup.
 *
 * It is honestly the weakest of the options and says so in its name and its description: the
 * markup is not an API and can change without warning, and the endpoint rate-limits. What it buys
 * is that "search the web" works on day one, and the better providers are an upgrade rather than a
 * prerequisite. It stays `available()` with nothing configured, which is not the same as being a
 * choice somebody made: a keyed provider outranks it, and the instant provider is what answers when
 * nobody has chosen — see `keyless` in `search/index.ts`.
 */

import { SearchError, type SearchProvider, type SearchRequest, type SearchResult, type SearchSource } from "./index.ts";

export const DUCKDUCKGO_PROVIDER_ID = "duckduckgo";

const ENDPOINT = "https://html.duckduckgo.com/html/";
/** A browser-shaped UA. The endpoint serves a different, script-dependent page to anything else. */
const USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
/** Waits between retries, in ms. Two attempts after the first; a third would be leaning on it. */
const BACKOFF_MS = [400, 1200];

export function duckDuckGoProvider(fetchImpl: typeof fetch = fetch): SearchProvider {
	return {
		id: DUCKDUCKGO_PROVIDER_ID,
		name: "DuckDuckGo（免配置，质量有限）",
		// Nothing to configure, so nothing can be missing.
		available: () => true,
		/*
		 * Registered and usable, but never picked on anybody's behalf: this is the endpoint that
		 * answers a program with its anti-automation page instead of results, so it runs when
		 * somebody asks for it by name.
		 */
		keyless: "optional",
		async search(request: SearchRequest): Promise<SearchResult> {
			const html = await fetchWithBackoff(fetchImpl, request);
			const sources = parseResults(html);
			if (sources.length === 0 && /anomaly|unusual traffic|blocked/i.test(html)) {
				// Being rate-limited and finding nothing look identical from the result list. Saying
				// which one it was is the difference between "try again" and "try another query".
				throw new SearchError("DuckDuckGo 暂时限流了，过一会儿再试", "SEARCH_RATE_LIMITED");
			}
			return { sources, truncated: false };
		},
	};
}

async function fetchWithBackoff(fetchImpl: typeof fetch, request: SearchRequest): Promise<string> {
	let lastError: unknown;
	for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
		if (attempt > 0) {
			await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS[attempt - 1]));
			if (request.signal?.aborted) throw new SearchError("搜索已取消", "SEARCH_ABORTED");
		}
		try {
			const response = await fetchImpl(ENDPOINT, {
				method: "POST",
				signal: request.signal,
				headers: { "user-agent": USER_AGENT, "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ q: request.query }).toString(),
			});
			// 202 is what this endpoint answers with when it wants you to slow down.
			if (response.status === 429 || response.status === 202) {
				lastError = new SearchError("DuckDuckGo 限流", "SEARCH_RATE_LIMITED");
				continue;
			}
			if (!response.ok) throw new SearchError(`DuckDuckGo 返回 HTTP ${response.status}`, "SEARCH_PROVIDER_ERROR");
			return await response.text();
		} catch (error) {
			if (error instanceof SearchError && error.code !== "SEARCH_RATE_LIMITED") throw error;
			lastError = error;
		}
	}
	throw lastError instanceof SearchError
		? lastError
		: new SearchError("DuckDuckGo 请求失败", "SEARCH_PROVIDER_ERROR", { cause: lastError });
}

/**
 * Pull results out of the no-JS results page.
 *
 * Anchored on the class names that page has used for years, and written to skip anything that does
 * not yield a real URL rather than to trust the shape. A result whose link cannot be unwrapped is
 * dropped: a source without a working URL is not a source, and inventing one would make the seam
 * lie about what it found.
 */
export function parseResults(html: string): SearchSource[] {
	const sources: SearchSource[] = [];
	const linkPattern = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
	const snippetPattern = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

	const snippets: string[] = [];
	for (const match of html.matchAll(snippetPattern)) snippets.push(stripTags(match[1]));

	let index = 0;
	for (const match of html.matchAll(linkPattern)) {
		const url = unwrapRedirect(match[1]);
		if (!url) {
			index += 1;
			continue;
		}
		const title = stripTags(match[2]);
		const snippet = snippets[index];
		sources.push({ url, ...(title ? { title } : {}), ...(snippet ? { snippet } : {}) });
		index += 1;
	}
	return sources;
}

/**
 * The real destination behind DuckDuckGo's click-tracking wrapper.
 *
 * Results link to `/l/?uddg=<encoded>` rather than to the site. Handing the wrapper to the model
 * would give it a URL that only works in a browser session and tells it nothing about where the
 * result came from.
 */
function unwrapRedirect(href: string): string | undefined {
	const decoded = href.replace(/&amp;/g, "&");
	const wrapped = /[?&]uddg=([^&]+)/.exec(decoded);
	const candidate = wrapped ? safeDecode(wrapped[1]) : decoded.startsWith("//") ? `https:${decoded}` : decoded;
	if (!candidate) return undefined;
	try {
		const url = new URL(candidate);
		return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
	} catch {
		return undefined;
	}
}

function safeDecode(value: string): string | undefined {
	try {
		return decodeURIComponent(value);
	} catch {
		return undefined;
	}
}

function stripTags(html: string): string {
	return html
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#x27;|&#39;/g, "'")
		.replace(/\s+/g, " ")
		.trim();
}
