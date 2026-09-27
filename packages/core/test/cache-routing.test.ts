/**
 * 缓存路由键：各类端点下请求体 / 请求头带不带、带成什么样；严格端点拒绝后学会不带并重发。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { cacheRouting, defaultCarriers, fitKey, sessionHeaders } from "../src/ai/cache-routing.ts";
import { openaiChatCompletionsProvider, resetChatCompletionsCompat } from "../src/ai/openai-chat-completions.ts";
import { openaiResponsesProvider } from "../src/ai/openai-responses.ts";
import { anthropicMessagesProvider } from "../src/ai/anthropic-messages.ts";
import { resetReasoningCompat } from "../src/ai/reasoning-compat.ts";
import { droppedParams, resetRequestParamsCompat } from "../src/ai/request-params-compat.ts";
import type { ApiFormat, AssistantMessage, ModelConfig, ProviderConfig } from "../src/types.ts";

const EMPTY = new Set<never>();

test("路由表：各端点的默认携带方式", () => {
	assert.deepEqual(defaultCarriers("https://api.openai.com/v1"), ["prompt_cache_key"]);
	assert.deepEqual(defaultCarriers("https://openrouter.ai/api/v1"), ["x-session-id"]);
	assert.deepEqual(defaultCarriers("https://api.moonshot.cn/v1"), ["prompt_cache_key"]);
	assert.deepEqual(defaultCarriers("https://api.deepseek.com"), []);
	assert.deepEqual(defaultCarriers("https://generativelanguage.googleapis.com/v1beta/openai"), []);
	assert.deepEqual(defaultCarriers("https://relay.example.com/v1"), ["prompt_cache_key"], "通用中转默认带请求体字段，拒了再学");
	assert.deepEqual(defaultCarriers("not a url"), ["prompt_cache_key"]);
	// 子域算，名字里碰巧包含不算。
	assert.deepEqual(defaultCarriers("https://eu.openrouter.ai/api"), ["x-session-id"]);
	assert.deepEqual(defaultCarriers("https://notopenrouter.ai.example.com"), ["prompt_cache_key"]);
});

test("路由：没有 cacheKey、Anthropic 协议、配置 off，一律什么都不带", () => {
	const openai = { baseUrl: "https://api.openai.com" };
	assert.deepEqual(cacheRouting(openai, "openai-responses", undefined, EMPTY), { body: {}, headers: {} });
	assert.deepEqual(cacheRouting(openai, "anthropic-messages", "s1", EMPTY), { body: {}, headers: {} });
	assert.deepEqual(cacheRouting({ ...openai, cacheRouting: "off" }, "openai-responses", "s1", EMPTY), { body: {}, headers: {} });
});

test("路由：用户点名一种方式就只用它；学到的撤销对点名的也生效", () => {
	const relay = { baseUrl: "https://relay.example.com", cacheRouting: "x-session-id" as const };
	assert.deepEqual(cacheRouting(relay, "openai-chat-completions", "s1", EMPTY), { body: {}, headers: { "x-session-id": "s1" } });
	const forced = { baseUrl: "https://api.deepseek.com", cacheRouting: "prompt_cache_key" as const };
	assert.deepEqual(cacheRouting(forced, "openai-chat-completions", "s1", EMPTY).body, { prompt_cache_key: "s1" });
	assert.deepEqual(cacheRouting(forced, "openai-chat-completions", "s1", new Set(["cache-key" as const])).body, {});
});

test("路由：配置里写了一个不认识的方式，什么都不带而不是乱带", () => {
	const odd = { baseUrl: "https://api.openai.com", cacheRouting: "bogus" as never };
	assert.deepEqual(cacheRouting(odd, "openai-responses", "s1", EMPTY), { body: {}, headers: {} });
});

test("fitKey：放得下原样用；超长的压成定长摘要，共享长前缀的两个键不会撞成一个", () => {
	assert.equal(fitKey("sess-123", 64), "sess-123");
	const base = `session-${"a".repeat(70)}`;
	const main = fitKey(base, 64);
	const sub = fitKey(`${base}-sub-1`, 64);
	assert.ok(main.length <= 64 && sub.length <= 64);
	assert.notEqual(main, sub, "截断会让子代理和主会话变成同一个键");
	assert.equal(fitKey(base, 64), main, "同一个键每次压出来一样，缓存才路由得到同一处");
	const unicode = fitKey("会话-1", 256);
	assert.match(unicode, /^[\x21-\x7e]+$/, "请求头只能是可见 ASCII，否则 fetch 直接抛");
	assert.notEqual(unicode, fitKey("会话-2", 256));
});

test("sessionHeaders：只有 OpenCode Go 带 x-opencode-session，没有会话时给随机 id", () => {
	assert.deepEqual(sessionHeaders("https://opencode.ai/zen/go", "s1"), { "x-opencode-session": "s1" });
	assert.deepEqual(sessionHeaders("https://opencode.ai/zen/go/v1/", "s1"), { "x-opencode-session": "s1" });
	assert.deepEqual(sessionHeaders("https://opencode.ai/zen/v1", "s1"), {}, "Zen 不要求");
	assert.deepEqual(sessionHeaders("https://relay.example.com/zen/go", "s1"), {});
	assert.deepEqual(sessionHeaders("not a url", "s1"), {});
	const probe = sessionHeaders("https://opencode.ai/zen/go", undefined)["x-opencode-session"];
	assert.match(probe, /^[0-9a-f-]{36}$/, "缺会话头会被拒，所以不删而是给一个随机 id");
	assert.notEqual(sessionHeaders("https://opencode.ai/zen/go", undefined)["x-opencode-session"], probe);
	assert.match(sessionHeaders("https://opencode.ai/zen/go", "会话-1")["x-opencode-session"], /^[\x21-\x7e]+$/, "请求头只能是可见 ASCII");
});

// ---------------------------------------------------------------------------
// 适配器：请求真的带上了 / 没带上
// ---------------------------------------------------------------------------

const CHAT_OK = [
	`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "好" }, finish_reason: "stop" }] })}`,
	`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 1 } })}`,
	"data: [DONE]",
	"",
].join("\n\n");

const RESPONSES_OK =
	[
		{ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "m1", content: [] } },
		{ type: "response.output_text.delta", output_index: 0, delta: "好" },
		{ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "m1", content: [{ type: "output_text", text: "好" }] } },
		{ type: "response.completed", response: { id: "r1", usage: { input_tokens: 10, output_tokens: 1 } } },
	]
		.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}`)
		.join("\n\n") + "\n\n";

const ANTHROPIC_OK =
	[
		{ type: "message_start", message: { id: "msg", usage: { input_tokens: 10, output_tokens: 1 } } },
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "好" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	]
		.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}`)
		.join("\n\n") + "\n\n";

/** Gemini OpenAI 兼容层对未知字段的说法——Google API JSON 解析的标准错误形状。 */
const UNKNOWN_FIELD_400 = JSON.stringify({
	error: { code: 400, message: 'Invalid JSON payload received. Unknown name "prompt_cache_key": Cannot find field.', status: "INVALID_ARGUMENT" },
});

const OK_BY_API: Record<ApiFormat, string> = {
	"openai-chat-completions": CHAT_OK,
	"openai-responses": RESPONSES_OK,
	"anthropic-messages": ANTHROPIC_OK,
};

function adapterOf(api: ApiFormat) {
	return api === "openai-chat-completions"
		? openaiChatCompletionsProvider
		: api === "openai-responses"
			? openaiResponsesProvider
			: anthropicMessagesProvider;
}

interface Sent {
	body: Record<string, unknown>;
	headers: Record<string, string>;
}

async function run(
	api: ApiFormat,
	provider: Partial<ProviderConfig>,
	cacheKey: string | undefined,
	statuses: number[] = [200],
): Promise<{ sent: Sent[]; done: AssistantMessage | null }> {
	const config: ProviderConfig = {
		id: "p",
		name: "P",
		baseUrl: "https://relay.example.com",
		api,
		apiKey: "k",
		enabled: true,
		models: [],
		...provider,
	};
	const model: ModelConfig = {
		id: `${config.id}/m`,
		providerId: config.id,
		modelId: "m",
		name: "m",
		contextWindow: 100_000,
		maxOutputTokens: 1000,
		supportsThinking: false,
		supportsImages: false,
		supportsTools: true,
	};
	const sent: Sent[] = [];
	const fetchStub = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
		sent.push({ body: JSON.parse(String(init?.body)), headers: { ...(init?.headers as Record<string, string>) } });
		const status = statuses[Math.min(sent.length - 1, statuses.length - 1)];
		return status === 200
			? new Response(OK_BY_API[api], { status, headers: { "content-type": "text/event-stream" } })
			: new Response(UNKNOWN_FIELD_400, { status, headers: { "content-type": "application/json" } });
	};
	let done: AssistantMessage | null = null;
	for await (const event of adapterOf(api).stream(
		config,
		model,
		{ systemPrompt: "", messages: [{ role: "user", content: [{ type: "text", text: "在吗" }], timestamp: 1 }], tools: [] },
		{ retryAttempts: 1, fetch: fetchStub as typeof globalThis.fetch, cacheKey },
	)) {
		if (event.type === "done") done = event.message;
	}
	return { sent, done };
}

function resetAll(): void {
	resetRequestParamsCompat();
	resetChatCompletionsCompat();
	resetReasoningCompat();
}

for (const api of ["openai-chat-completions", "openai-responses"] as const) {
	test(`${api}：OpenAI 官方带 prompt_cache_key，不带会话头`, async () => {
		resetAll();
		const { sent } = await run(api, { id: `openai-${api}`, baseUrl: "https://api.openai.com/v1" }, "sess-1");
		assert.equal(sent[0].body.prompt_cache_key, "sess-1");
		assert.equal("x-session-id" in sent[0].headers, false);
	});

	test(`${api}：OpenRouter 带 x-session-id 头，请求体不加字段`, async () => {
		resetAll();
		const { sent } = await run(api, { id: `or-${api}`, baseUrl: "https://openrouter.ai/api/v1" }, "sess-1");
		assert.equal(sent[0].headers["x-session-id"], "sess-1");
		assert.equal("prompt_cache_key" in sent[0].body, false);
	});

	test(`${api}：DeepSeek 什么都不带`, async () => {
		resetAll();
		const { sent } = await run(api, { id: `ds-${api}`, baseUrl: "https://api.deepseek.com" }, "sess-1");
		assert.equal("prompt_cache_key" in sent[0].body, false);
		assert.equal("x-session-id" in sent[0].headers, false);
	});

	test(`${api}：没传 cacheKey 时请求和从前一模一样`, async () => {
		resetAll();
		const { sent } = await run(api, { id: `none-${api}`, baseUrl: "https://api.openai.com" }, undefined);
		assert.equal("prompt_cache_key" in sent[0].body, false);
	});

	test(`${api}：严格端点点名拒绝 prompt_cache_key，学会不带并重发一次，之后的请求也不带`, async () => {
		resetAll();
		const id = `strict-${api}`;
		const first = await run(api, { id, baseUrl: "https://relay.example.com/v1" }, "sess-1", [400, 200]);
		assert.equal(first.sent.length, 2);
		assert.equal(first.sent[0].body.prompt_cache_key, "sess-1");
		assert.equal("prompt_cache_key" in first.sent[1].body, false);
		assert.ok(first.done, "重发那一次成功了");
		assert.ok(droppedParams(id, `${id}/m`).has("cache-key"));

		const next = await run(api, { id, baseUrl: "https://relay.example.com/v1" }, "sess-2");
		assert.equal(next.sent.length, 1);
		assert.equal("prompt_cache_key" in next.sent[0].body, false, "学到的结论下一轮直接生效，不再先撞一次");
	});
}

test("anthropic-messages：协议没有路由字段，请求体和请求头都不带", async () => {
	resetAll();
	const { sent } = await run("anthropic-messages", { id: "an", baseUrl: "https://openrouter.ai/api" }, "sess-1");
	assert.equal("prompt_cache_key" in sent[0].body, false);
	assert.equal("x-session-id" in sent[0].headers, false);
});

for (const api of ["openai-chat-completions", "openai-responses", "anthropic-messages"] as const) {
	test(`${api}：OpenCode Go 带 x-opencode-session，关掉缓存路由也照带`, async () => {
		resetAll();
		const provider = { id: `oc-${api}`, baseUrl: "https://opencode.ai/zen/go", cacheRouting: "off" as const };
		const { sent } = await run(api, provider, "sess-1");
		assert.equal(sent[0].headers["x-opencode-session"], "sess-1");
		const bare = await run(api, provider, undefined);
		assert.match(bare.sent[0].headers["x-opencode-session"], /^[0-9a-f-]{36}$/);
	});
}
