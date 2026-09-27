/**
 * Choosing who answers a search, and reading what comes back.
 *
 * The selection rules get the most attention because the failure they prevent is a quiet one: with
 * "first registered wins", which service runs depends on plugin load order, and a user who
 * configured Tavily could silently be paying DuckDuckGo's accuracy for it. Every ambiguous case is
 * an error here instead.
 *
 * "Several usable and nothing chosen" is not one of those cases, though: two of the providers ship
 * needing no key, so a fresh install would land in it and stay there until somebody opened a page
 * they have no reason to open yet. One of them is named as the default instead — and it is the one
 * the seam is allowed to pick without being told.
 *
 * The parsing tests use real fixture markup and real payload shapes rather than stubs of our own
 * design — a parser tested against the shape it was written for proves nothing.
 */

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { parseResults, duckDuckGoProvider } from "../src/search/duckduckgo.ts";
import {
	registerSearchProvider,
	resetSearchProviders,
	search,
	SearchError,
	selectSearchProvider,
	type SearchProvider,
} from "../src/search/index.ts";
import { instantAnswerProvider } from "../src/search/instant.ts";
import { keyedSearchProvider, BRAVE_PROVIDER_ID, TAVILY_PROVIDER_ID, EXA_PROVIDER_ID } from "../src/search/keyed.ts";

function fake(id: string, usable: boolean, sources = 1): SearchProvider {
	return {
		id,
		name: id,
		available: () => usable,
		search: async () => ({
			sources: Array.from({ length: sources }, (_, i) => ({ url: `https://${id}.example/${i}` })),
			truncated: false,
		}),
	};
}

/** A provider that needs no key, with the role the seam gives it when nobody has chosen. */
function keylessFake(id: string, role: "default" | "optional"): SearchProvider {
	return { ...fake(id, true), keyless: role };
}

beforeEach(() => resetSearchProviders());

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

test("one usable provider is chosen without being configured", () => {
	registerSearchProvider(fake("only", true));
	assert.equal(selectSearchProvider().id, "only");
});

test("an unusable provider is not chosen just for being alone", () => {
	registerSearchProvider(fake("keyless", false));
	assert.throws(() => selectSearchProvider(), /没有可用/);
});

test("several configured providers with no choice made is an error, not a coin toss", () => {
	// "Whichever plugin loaded first" is not a decision anybody made. Neither is "whichever of the
	// two keys you pasted" — that one is still a question for whoever pasted them.
	registerSearchProvider(fake("a", true));
	registerSearchProvider(fake("b", true));
	assert.throws(() => selectSearchProvider(), (error: SearchError) => error.code === "SEARCH_PROVIDER_AMBIGUOUS");
});

test("a configured id wins even when others are usable", () => {
	registerSearchProvider(fake("a", true));
	registerSearchProvider(fake("b", true));
	assert.equal(selectSearchProvider("b").id, "b");
});

test("each way of being unusable has its own code, because each has its own fix", () => {
	registerSearchProvider(fake("present-but-keyless", false));
	assert.throws(() => selectSearchProvider("not-registered"), (e: SearchError) => e.code === "SEARCH_PROVIDER_MISSING");
	assert.throws(
		() => selectSearchProvider("present-but-keyless"),
		(e: SearchError) => e.code === "SEARCH_PROVIDER_UNAVAILABLE",
	);
});

test("registering the same id twice is a programming error", () => {
	registerSearchProvider(fake("dup", true));
	assert.throws(() => registerSearchProvider(fake("dup", true)), (e: SearchError) => e.code === "SEARCH_DUPLICATE_PROVIDER");
});

test("a disposer takes the registration back", () => {
	const dispose = registerSearchProvider(fake("temp", true));
	assert.equal(selectSearchProvider().id, "temp");
	dispose();
	assert.throws(() => selectSearchProvider());
});

test("the keyless default answers when nobody has chosen", () => {
	// The state every fresh install is in: both keyless providers are usable and the settings file
	// has never been opened. Asking for a choice here would leave web_search failing until somebody
	// visited a page they have no reason to visit yet.
	registerSearchProvider(keylessFake("answers", "default"));
	registerSearchProvider(keylessFake("scrape", "optional"));
	assert.equal(selectSearchProvider().id, "answers");
});

test("a key somebody pasted outranks the keyless default", () => {
	// Pasting a key without also clicking a radio is easy to do — the page lists the key fields
	// below the choice. Answering that with the default would quietly ignore what they set up.
	registerSearchProvider(keylessFake("answers", "default"));
	registerSearchProvider(fake("tavily", true));
	assert.equal(selectSearchProvider().id, "tavily");
});

test("a keyless provider that is not the default is never picked on its own", () => {
	registerSearchProvider(keylessFake("a", "optional"));
	registerSearchProvider(keylessFake("b", "optional"));
	assert.throws(() => selectSearchProvider(), (error: SearchError) => error.code === "SEARCH_PROVIDER_AMBIGUOUS");
});

test("a keyless provider picked by name runs, default or not", () => {
	registerSearchProvider(keylessFake("answers", "default"));
	registerSearchProvider(keylessFake("scrape", "optional"));
	assert.equal(selectSearchProvider("scrape").id, "scrape");
});

test("a second keyless default is a programming error", () => {
	registerSearchProvider(keylessFake("first", "default"));
	assert.throws(
		() => registerSearchProvider(keylessFake("second", "default")),
		(error: SearchError) => error.code === "SEARCH_DUPLICATE_DEFAULT",
	);
});

// ---------------------------------------------------------------------------
// The bound the seam enforces
// ---------------------------------------------------------------------------

test("the seam truncates a provider that over-returns", async () => {
	// A bound every adapter has to remember is one some adapter will not.
	registerSearchProvider(fake("chatty", true, 20));
	const result = await search({ query: "x", maxResults: 3 });
	assert.equal(result.sources.length, 3);
	assert.equal(result.truncated, true);
});

test("a provider inside the bound is not marked truncated", async () => {
	registerSearchProvider(fake("polite", true, 2));
	const result = await search({ query: "x", maxResults: 8 });
	assert.equal(result.sources.length, 2);
	assert.equal(result.truncated, false);
});

// ---------------------------------------------------------------------------
// DuckDuckGo parsing
// ---------------------------------------------------------------------------

const FIXTURE = `
<div class="results">
  <div class="result results_links">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fapi%2Ffs.html&amp;rut=abc">Node.js <b>fs</b> docs</a>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">The <b>fs</b> module enables interacting with the file system.</a>
  </div>
  <div class="result results_links">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fb">Second &amp; result</a>
    <a class="result__snippet" href="#">Another snippet</a>
  </div>
</div>`;

test("results are unwrapped from the click tracker", () => {
	// The raw href only works inside a browser session and says nothing about where the result is.
	const sources = parseResults(FIXTURE);
	assert.equal(sources.length, 2);
	assert.equal(sources[0].url, "https://nodejs.org/api/fs.html");
	assert.equal(sources[1].url, "https://example.com/b");
});

test("titles and snippets come back as text, not markup", () => {
	const sources = parseResults(FIXTURE);
	assert.equal(sources[0].title, "Node.js fs docs");
	assert.equal(sources[0].snippet, "The fs module enables interacting with the file system.");
	assert.equal(sources[1].title, "Second & result");
});

test("a result whose link cannot be unwrapped is dropped, not guessed at", () => {
	const broken = `<a class="result__a" href="//duckduckgo.com/l/?uddg=%%%">Broken</a>`;
	assert.deepEqual(parseResults(broken), []);
});

test("nothing found is an empty list rather than an exception", () => {
	assert.deepEqual(parseResults("<div>no results</div>"), []);
});

test("being rate-limited is reported as that, not as nothing found", async () => {
	// From the result list alone the two are identical, and the difference is "try again later"
	// versus "try another query".
	const provider = duckDuckGoProvider(async () => new Response("unusual traffic detected", { status: 200 }));
	await assert.rejects(provider.search({ query: "x" }), (e: SearchError) => e.code === "SEARCH_RATE_LIMITED");
});

// ---------------------------------------------------------------------------
// Keyed providers
// ---------------------------------------------------------------------------

test("a keyed provider is unavailable until the key is there, and available the moment it is", () => {
	let key: string | undefined;
	const provider = keyedSearchProvider(TAVILY_PROVIDER_ID, () => key);
	assert.equal(provider.available(), false);
	key = "tvly-xxx";
	// Read through a function so pasting a key into settings does not need a restart.
	assert.equal(provider.available(), true);
	key = "   ";
	assert.equal(provider.available(), false);
});

test("Tavily's answer and results are both carried across", async () => {
	const provider = keyedSearchProvider(
		TAVILY_PROVIDER_ID,
		() => "k",
		async () =>
			new Response(
				JSON.stringify({
					answer: "fs 是 Node 的文件系统模块",
					results: [{ url: "https://nodejs.org/api/fs.html", title: "fs", content: "File system" }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
	);
	const result = await provider.search({ query: "node fs" });
	assert.equal(result.content, "fs 是 Node 的文件系统模块");
	assert.equal(result.sources[0].url, "https://nodejs.org/api/fs.html");
});

test("an Exa result with no highlight is dropped rather than returned empty", async () => {
	const provider = keyedSearchProvider(
		EXA_PROVIDER_ID,
		() => "k",
		async () =>
			new Response(
				JSON.stringify({
					results: [
						{ url: "https://a.example", title: "A", highlights: ["a useful sentence"] },
						{ url: "https://b.example", title: "B", highlights: [] },
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
	);
	const result = await provider.search({ query: "x" });
	assert.equal(result.sources.length, 1, "there is no other field to derive a snippet from");
	assert.equal(result.sources[0].url, "https://a.example");
});

test("a rejected key says so specifically", async () => {
	const provider = keyedSearchProvider(TAVILY_PROVIDER_ID, () => "bad", async () => new Response("", { status: 401 }));
	await assert.rejects(provider.search({ query: "x" }), (e: SearchError) => e.code === "SEARCH_PROVIDER_UNAUTHORIZED");
});

// ---------------------------------------------------------------------------
// The keyless Instant Answer provider
// ---------------------------------------------------------------------------

test("the instant provider flattens nested topic groups", async () => {
	// `RelatedTopics` mixes bare entries with named groups whose members live one level down. A
	// reader that only walks the top level loses most of the answer for any query that lands on a
	// category — which is most of the interesting ones.
	const provider = instantAnswerProvider(
		async () =>
			new Response(
				JSON.stringify({
					AbstractText: "Python is a language",
					AbstractURL: "https://en.wikipedia.org/wiki/Python",
					RelatedTopics: [
						{ FirstURL: "https://a.example", Text: "A - about a" },
						{ Name: "Group", Topics: [{ FirstURL: "https://b.example", Text: "B - about b" }] },
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
	);
	const result = await provider.search({ query: "python" });
	assert.equal(result.content, "Python is a language");
	assert.deepEqual(
		result.sources.map((s) => s.url),
		["https://en.wikipedia.org/wiki/Python", "https://a.example", "https://b.example"],
	);
	assert.equal(result.sources[1].title, "A", "the title is the part before the dash, the snippet is all of it");
});

test("the instant provider does not repeat a URL that appears twice", async () => {
	const provider = instantAnswerProvider(
		async () =>
			new Response(
				JSON.stringify({
					AbstractURL: "https://same.example",
					AbstractText: "x",
					RelatedTopics: [{ FirstURL: "https://same.example", Text: "x again" }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
	);
	assert.equal((await provider.search({ query: "x" })).sources.length, 1);
});

test("a query the instant API knows nothing about is an empty result, not an error", async () => {
	// This is the honest common case for Chinese queries, and the tool renders it as "没有找到结果"
	// rather than as a failure the model should retry.
	const provider = instantAnswerProvider(
		async () => new Response(JSON.stringify({ RelatedTopics: [] }), { status: 200, headers: { "content-type": "application/json" } }),
	);
	const result = await provider.search({ query: "什么是 Docker" });
	assert.deepEqual(result.sources, []);
	assert.equal(result.content, undefined);
});

test("Brave sends its query in the URL and strips the bolding it adds", async () => {
	// Brave is the one provider that reads its query from the query string rather than a body, and
	// it wraps matched terms in `<strong>` for a browser to bold. A model reading that markup may
	// reasonably echo it back.
	let seen = "";
	const provider = keyedSearchProvider(
		BRAVE_PROVIDER_ID,
		() => "k",
		async (url) => {
			seen = String(url);
			return new Response(
				JSON.stringify({
					web: {
						results: [
							{ url: "https://nodejs.org/api/fs.html", title: "Node <strong>fs</strong>", description: "The <strong>fs</strong> module" },
						],
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		},
	);
	const result = await provider.search({ query: "node fs", maxResults: 5 });
	assert.match(seen, /[?&]q=node\+fs/);
	assert.match(seen, /[?&]count=5/);
	assert.equal(result.sources[0].title, "Node fs");
	assert.equal(result.sources[0].snippet, "The fs module");
});

test("webSearchTool accepts pattern and search aliases", async () => {
	const { webSearchTool } = await import("../src/tools/search.ts");
	registerSearchProvider(fake("alias-test", true, 2));
	const res = await webSearchTool.execute({ pattern: "test query" } as any, { cwd: "/tmp", sessionId: "s", state: new Map() });
	assert.match(res.content[0].text, /alias-test\.example/);
});
