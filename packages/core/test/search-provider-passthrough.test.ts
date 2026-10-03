/**
 * The provider the user picked has to reach the tool that searches.
 *
 * `selectSearchProvider` already knows what to do with a choice — use it, or refuse when several
 * providers are usable and none was made. What it cannot see is whether the choice arrives: a
 * turn can build a correct `ToolContext` and still call `search()` without the id, which leaves
 * the setting in settings and sends every request wherever the registry happens to point, with
 * nothing failing. Both ends are therefore asserted here — the id on the context, and the id on
 * the call.
 */

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import type { AgentRunConfig } from "../src/agent/loop.ts";
import { runTools } from "../src/agent/tool-run.ts";
import { DEFAULT_SETTINGS, type Settings } from "../src/config/settings.ts";
import { buildTurnConfig } from "../src/runtime/turn-config.ts";
import { registerSearchProvider, resetSearchProviders, type SearchProvider, type SearchRequest } from "../src/search/index.ts";
import { webSearchTool } from "../src/tools/search.ts";
import type { AssistantContent, Tool, ToolContext } from "../src/types.ts";

type ToolCall = Extract<AssistantContent, { type: "toolCall" }>;

/** A provider that answers locally, and remembers what it was asked. */
function fakeProvider(id: string, requests: Map<string, SearchRequest[]>): SearchProvider {
	const seen: SearchRequest[] = [];
	requests.set(id, seen);
	return {
		id,
		name: id,
		available: () => true,
		search: async (request) => {
			seen.push(request);
			return { sources: [{ url: `https://${id}.example/answer` }], truncated: false };
		},
	};
}

/*
 * Through the real assembly, not a hand-built config: `buildTurnConfig` is the only place that
 * reads settings on behalf of a turn, and `tool-run.ts` the only place that puts them on a
 * `ToolContext`. Those two hops are the feature; a config literal would test neither.
 */
function configFor(settings: Settings, tools: Tool[]): AgentRunConfig {
	return buildTurnConfig(
		{
			sessionId: "search-provider",
			cwd: process.cwd(),
			provider: { id: "p", name: "p", baseUrl: "", api: "openai", apiKey: "", enabled: true, models: [] },
			model: { id: "m", name: "m", modelId: "m", providerId: "p" },
			settings,
			state: new Map(),
			tools,
			skills: [],
			agents: [],
			requestApproval: async () => "reject",
			emit: async () => {},
			beforeToolCall: undefined,
			afterToolCall: undefined,
			drainSteering: undefined,
		} as unknown as Parameters<typeof buildTurnConfig>[0],
		{ systemPrompt: "", messages: [], tools, cwd: process.cwd() },
		"",
	);
}

function probeTool(seen: ToolContext[]): Tool {
	return {
		name: "probe",
		snippet: "probe",
		description: "probe",
		parameters: { type: "object", properties: {} },
		execute: async (_args, ctx) => {
			seen.push(ctx);
			return { content: [{ type: "text", text: "ok" }] };
		},
	};
}

function call(name: string, args: Record<string, unknown>): ToolCall[] {
	return [{ type: "toolCall", id: "c1", name, arguments: args }];
}

/** Run the calls with the turn's `tools` group, as the loop does. */
function run(calls: ToolCall[], config: AgentRunConfig) {
	return runTools(calls, config.tools, { sessionId: config.session.sessionId, signal: config.control.signal, state: new Map() }, async () => {});
}

beforeEach(() => resetSearchProviders());

test("a turn built from settings hands the chosen provider to its tools", async () => {
	const seen: ToolContext[] = [];
	const config = configFor({ ...DEFAULT_SETTINGS, searchProvider: "tavily" }, [probeTool(seen)]);

	await run(call("probe", {}), config);

	assert.equal(seen.length, 1, "the tool never ran");
	assert.equal(seen[0].searchProviderId, "tavily");
});

test("a turn built from settings with no choice states that rather than leaving it out", async () => {
	const seen: ToolContext[] = [];
	await run(call("probe", {}), configFor({ ...DEFAULT_SETTINGS }, [probeTool(seen)]));

	assert.equal(seen.length, 1, "the tool never ran");
	assert.equal(seen[0].searchProviderId, null);
});

test("web_search asks the provider the user picked", async () => {
	const requests = new Map<string, SearchRequest[]>();
	registerSearchProvider(fakeProvider("tavily", requests));
	registerSearchProvider(fakeProvider("exa", requests));

	const [result] = await run(
		call("web_search", { query: "how tall is the Eiffel Tower" }),
		configFor({ ...DEFAULT_SETTINGS, searchProvider: "tavily" }, [webSearchTool]),
	);

	assert.equal(result.isError, false, JSON.stringify(result.content));
	assert.match(JSON.stringify(result.content), /tavily\.example/, "the answer did not come from the chosen provider");
	assert.equal(requests.get("tavily")?.length, 1, "the chosen provider was not the one asked");
	assert.equal(requests.get("exa")?.length, 0, "a provider the user did not choose was asked");
});

test("web_search with no choice picks no provider on the user's behalf", async () => {
	const requests = new Map<string, SearchRequest[]>();
	registerSearchProvider(fakeProvider("tavily", requests));
	registerSearchProvider(fakeProvider("exa", requests));

	const [result] = await run(call("web_search", { query: "anything" }), configFor({ ...DEFAULT_SETTINGS }, [webSearchTool]));

	assert.equal(result.isError, true);
	assert.match(JSON.stringify(result.content), /SEARCH_PROVIDER_AMBIGUOUS/);
	assert.equal(requests.get("tavily")?.length, 0);
});
