/**
 * The keyless option that actually answers.
 *
 * The HTML endpoint this app also ships is the one people expect — it returns real web results —
 * and it blocks automated requests whenever it feels like it, which in practice is most of the
 * time. That is not a bug in the adapter; every free search endpoint does it, and no amount of
 * header-shaping changes the outcome for long.
 *
 * This is DuckDuckGo's documented Instant Answer API. It is stable, it is not rate-limited in
 * normal use, and it needs no account. The trade is real and worth stating: it does **not** return
 * a ranked list of web pages. It returns the encyclopaedic answer and related topics — which
 * covers "what is X" and "which page documents Y" and does not cover "find me recent discussion
 * about Z".
 *
 * So it is the honest keyless answer to "search the web" rather than a pretend one: fewer
 * questions answered, but the ones it answers, it answers.
 */

import { SearchError, type SearchProvider, type SearchRequest, type SearchResult, type SearchSource } from "./index.ts";

export const INSTANT_PROVIDER_ID = "ddg-instant";

const ENDPOINT = "https://api.duckduckgo.com/";

interface InstantTopic {
	FirstURL?: string;
	Text?: string;
	/** Nested groups: the API returns categories whose members live one level down. */
	Topics?: InstantTopic[];
	Name?: string;
}

interface InstantPayload {
	AbstractText?: string;
	AbstractURL?: string;
	AbstractSource?: string;
	Heading?: string;
	Answer?: string;
	Definition?: string;
	DefinitionURL?: string;
	DefinitionSource?: string;
	RelatedTopics?: InstantTopic[];
}

export function instantAnswerProvider(fetchImpl: typeof fetch = fetch): SearchProvider {
	return {
		id: INSTANT_PROVIDER_ID,
		name: "DuckDuckGo 速答（免配置，只有百科式答案）",
		// Nothing to configure, and the endpoint does not gate on anything local.
		available: () => true,
		/*
		 * The default, because it is the only keyless one that answers in practice: asked with the
		 * user agent this app sends, the HTML endpoint replies with its anti-automation page every
		 * time, while this one answers in a few hundred milliseconds and does not rate-limit.
		 */
		keyless: "default",
		async search(request: SearchRequest): Promise<SearchResult> {
			const url = new URL(ENDPOINT);
			url.searchParams.set("q", request.query);
			url.searchParams.set("format", "json");
			url.searchParams.set("no_html", "1");
			url.searchParams.set("skip_disambig", "1");
			url.searchParams.set("t", "plume");

			let response: Response;
			try {
				response = await fetchImpl(url, { signal: request.signal, headers: { accept: "application/json" } });
			} catch (error) {
				throw new SearchError("速答接口请求失败", "SEARCH_PROVIDER_ERROR", { cause: error });
			}
			if (response.status === 429) throw new SearchError("速答接口限流了", "SEARCH_RATE_LIMITED");
			if (!response.ok) throw new SearchError(`速答接口返回 HTTP ${response.status}`, "SEARCH_PROVIDER_ERROR");

			let payload: InstantPayload;
			try {
				payload = (await response.json()) as InstantPayload;
			} catch (error) {
				throw new SearchError("速答接口的返回读不懂", "SEARCH_PROVIDER_ERROR", { cause: error });
			}

			return {
				...(answerOf(payload) ? { content: answerOf(payload) } : {}),
				sources: sourcesOf(payload, request.maxResults ?? 8),
				truncated: false,
			};
		},
	};
}

/** The direct answer, when there is one — a definition, a computation, an abstract. */
function answerOf(payload: InstantPayload): string | undefined {
	const parts = [payload.Answer, payload.AbstractText, payload.Definition].map((p) => p?.trim()).filter(Boolean);
	return parts.length > 0 ? parts[0] : undefined;
}

/**
 * Everything with a URL, flattened.
 *
 * `RelatedTopics` mixes bare topics with named groups whose members are one level down, and a
 * consumer that only reads the top level silently loses most of the answer for any query that
 * lands on a category.
 */
function sourcesOf(payload: InstantPayload, limit: number): SearchSource[] {
	const sources: SearchSource[] = [];
	const seen = new Set<string>();

	const add = (url: string | undefined, text: string | undefined) => {
		if (!url || seen.has(url) || sources.length >= limit) return;
		seen.add(url);
		const snippet = text?.trim();
		sources.push({
			url,
			// The first sentence is the title in this API's shape; the rest is the snippet.
			...(snippet ? { title: snippet.split(" - ")[0].slice(0, 80), snippet } : {}),
		});
	};

	add(payload.AbstractURL, payload.AbstractText ?? payload.Heading);
	add(payload.DefinitionURL, payload.Definition);

	const walk = (topics: InstantTopic[] | undefined, depth: number) => {
		if (!topics || depth > 3) return;
		for (const topic of topics) {
			if (topic.Topics) walk(topic.Topics, depth + 1);
			else add(topic.FirstURL, topic.Text);
		}
	};
	walk(payload.RelatedTopics, 0);

	return sources;
}
