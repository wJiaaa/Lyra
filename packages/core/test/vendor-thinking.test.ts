/**
 * `ai/vendors/`：每个模型族的思考开关在三种格式下实际发出去的是什么。
 *
 * 这里每一行防的都是同一类事故：端点**不报错**，只是静默忽略——档位送不到、关也关不掉，用户看不见，
 * 账单照收。这种只能事先写下来，写下来之后就得有人看着它不被改坏。请求体从适配器的 `onPayload` 抓，
 * 不读 vendors 的内部结构。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { anthropicMessagesProvider } from "../src/ai/anthropic-messages.ts";
import { openaiChatCompletionsProvider } from "../src/ai/openai-chat-completions.ts";
import { openaiResponsesProvider } from "../src/ai/openai-responses.ts";
import { thinkingOptionsFor } from "../src/ai/thinking-options.ts";
import { thinkingDialect } from "../src/ai/vendors/index.ts";
import { anthropicThinkingFields } from "../src/ai/vendors/thinking.ts";
import { catalogFill } from "../src/model-catalog.ts";
import type { ModelConfig, Provider, ProviderConfig } from "../src/types/provider.ts";

const LEVELS = thinkingOptionsFor(["off", "low", "medium", "high", "xhigh", "max"]);

/** 发一次，抓下请求体就停。 */
async function payload(adapter: Provider, baseUrl: string, modelId: string, thinking: string): Promise<Record<string, unknown>> {
	const model: ModelConfig = {
		id: `qa/${modelId}`, providerId: "qa", modelId, name: modelId,
		supportsThinking: true, supportsImages: false, supportsTools: true, contextWindow: 200_000, maxOutputTokens: 32_768, thinkingOptions: LEVELS,
	};
	const provider: ProviderConfig = { id: "qa", name: "QA", api: adapter.api, apiKey: "k", baseUrl, enabled: true, models: [model] };
	let captured: Record<string, unknown> | undefined;
	const stream = adapter.stream(provider, model, { systemPrompt: "", messages: [], tools: [] }, {
		thinking,
		retryAttempts: 1,
		onPayload: (body) => { captured ??= body as Record<string, unknown>; },
		fetch: async () => new Response(JSON.stringify({ error: { message: "stop after payload capture" } }), { status: 400 }),
	});
	for await (const event of stream) if (event.type === "error") break;
	assert.ok(captured, `${adapter.api} ${modelId}`);
	return captured;
}

/** 只看和思考开关有关的那几个键。 */
function thinkingKeys(body: Record<string, unknown>): Record<string, unknown> {
	const keys = ["thinking", "output_config", "reasoning_effort", "reasoning"];
	return Object.fromEntries(keys.filter((key) => key in body).map((key) => [key, body[key]]));
}

const budget = (tokens: number) => ({ thinking: { type: "enabled", budget_tokens: tokens } });

test("Anthropic 格式：开、关思考发的字段", async () => {
	const cases: [string, string, string, Record<string, unknown>][] = [
		// DeepSeek 认 effort、忽略 budget。
		["https://api.deepseek.com/anthropic", "deepseek-v4-pro", "max", { thinking: { type: "enabled" }, output_config: { effort: "max" } }],
		// GLM-5.2+ 认 effort、忽略 budget。
		["https://open.bigmodel.cn/api/anthropic", "glm-5.2", "medium", { thinking: { type: "enabled" }, output_config: { effort: "medium" } }],
		["https://api.z.ai/api/anthropic", "glm-5.3", "high", { thinking: { type: "enabled" }, output_config: { effort: "high" } }],
		// Kimi K3 的请求结构里没有 thinking，只有 output_config.effort。
		["https://api.moonshot.ai/anthropic", "kimi-k3", "low", { output_config: { effort: "low" } }],
		// 新 Claude 只认 adaptive（省掉第一次的 400）。
		["https://api.anthropic.com", "claude-opus-5", "medium", { thinking: { type: "adaptive" }, output_config: { effort: "medium" } }],
		// 默认仍是 budget：没登记的模型。
		["https://open.bigmodel.cn/api/anthropic", "glm-4.7", "high", budget(24_576)],
		["https://api.anthropic.com", "claude-opus-4-5", "high", budget(24_576)],
	];
	for (const [baseUrl, modelId, level, expected] of cases) {
		assert.deepEqual(thinkingKeys(await payload(anthropicMessagesProvider, baseUrl, modelId, level)), expected, `${modelId} ${level}`);
	}
	for (const [baseUrl, modelId] of [["https://api.deepseek.com/anthropic", "deepseek-v4-pro"], ["https://api.anthropic.com", "claude-opus-4-5"], ["https://api.z.ai/api/anthropic", "glm-5.2"]]) {
		assert.deepEqual(thinkingKeys(await payload(anthropicMessagesProvider, baseUrl, modelId, "off")), { thinking: { type: "disabled" } }, `${modelId} off`);
	}
	// 关不掉的不给「关闭」（`resolveModelThinkingOptions`），旧配置里留着的「关闭」落到最浅一档，按开着的写法发。
	assert.deepEqual(thinkingKeys(await payload(anthropicMessagesProvider, "https://api.z.ai/api/anthropic", "glm-5.3", "off")), { thinking: { type: "enabled" }, output_config: { effort: "low" } });
	assert.deepEqual(thinkingKeys(await payload(anthropicMessagesProvider, "https://api.moonshot.ai/anthropic", "kimi-k3", "off")), { output_config: { effort: "low" } });
});

test("Chat 格式：关思考明说 none，Gemini 例外", async () => {
	const cases: [string, string, string, Record<string, unknown>][] = [
		["https://api.deepseek.com", "deepseek-v4-flash", "high", { reasoning_effort: "high" }],
		// DeepSeek 实测关得掉的就是这个写法。
		["https://api.deepseek.com", "deepseek-v4-flash", "off", { reasoning_effort: "none" }],
		["https://generativelanguage.googleapis.com/v1beta/openai", "gemini-2.5-flash", "off", {}],
		["https://openrouter.ai/api/v1", "google/gemini-2.5-pro", "off", {}],
		// 关不掉：不发 none，「关闭」落到最浅一档。
		["https://api.z.ai/api/paas/v4", "glm-5.3", "off", { reasoning_effort: "low" }],
		["https://api.moonshot.ai/v1", "kimi-k3", "off", { reasoning_effort: "low" }],
	];
	for (const [baseUrl, modelId, level, expected] of cases) {
		assert.deepEqual(thinkingKeys(await payload(openaiChatCompletionsProvider, baseUrl, modelId, level)), expected, `${baseUrl} ${modelId} ${level}`);
	}
});

test("Responses 格式：拒 none 的模型族关思考时整段不发", async () => {
	for (const modelId of ["o1", "o3", "O3-mini", "openai/o4-mini", "gpt-5", "gpt-5-codex", "gpt-5-2025-08-07", "gemini-2.5-flash"]) {
		assert.deepEqual(thinkingKeys(await payload(openaiResponsesProvider, "https://api.openai.com/v1", modelId, "off")), {}, modelId);
	}
	for (const modelId of ["gpt-5.1", "gpt-5.2-codex", "gpt-4o1-relay", "deepseek-v4-flash"]) {
		assert.deepEqual(thinkingKeys(await payload(openaiResponsesProvider, "https://api.openai.com/v1", modelId, "off")), { reasoning: { effort: "none" } }, modelId);
	}
});

test("规则的边界：K3 的名字、GLM 的版本", () => {
	for (const id of ["kimi-k3", "moonshotai/kimi-k3", "k3", "kimi-k3[1m]", "kimi-k3-0901"]) assert.equal(thinkingDialect("", id).anthropic, "effort-only", id);
	for (const id of ["kimi-k2.6", "kimi-k30", "dk3"]) assert.equal(thinkingDialect("", id).anthropic, "budget", id);
	assert.equal(thinkingDialect("", "glm-5.3-flash").alwaysOn, true);
	assert.equal(thinkingDialect("", "glm-5.2").alwaysOn, false);
	assert.equal(thinkingDialect("", "glm-5.1").anthropic, "budget");
});

test("关不掉的模型，目录填出来的档位里没有「关闭」；关得掉的照旧有", () => {
	const entry = (id: string) => ({ id, name: id, contextWindow: 262_144, maxOutputTokens: 32_768, supportsThinking: true, thinkingLevels: ["off", "high"], supportsImages: false }) as never;
	const ids = (id: string) => catalogFill(entry(id)).thinkingOptions?.map((option) => option.id);
	assert.deepEqual(ids("glm-5.3"), ["high"]);
	assert.deepEqual(ids("kimi-k3"), ["high"]);
	assert.deepEqual(ids("glm-5.2"), ["off", "high"]);
});

test("DeepSeek 按地址或模型名都认", () => {
	assert.equal(thinkingDialect("https://relay.example.com", "deepseek/deepseek-v4-pro").anthropic, "enabled-effort");
	assert.equal(thinkingDialect("https://api.deepseek.com/anthropic", "some-alias").anthropic, "enabled-effort");
	assert.equal(thinkingDialect("https://deepseek-proxy.example/v1", "some-alias").leadingReasoning, true, "自建转发：地址带 deepseek 就认");
	assert.equal(thinkingDialect("https://api.deepseek.com", "deepseek-flash").leadingReasoning, true);
	assert.equal(thinkingDialect("https://api.openai.com/v1", "gpt-5.1").leadingReasoning, false);
	// OpenAI 那条只管 Responses：Chat 链对 o3 照旧明说 none。
	assert.equal(thinkingDialect("https://api.openai.com/v1", "o3").chatRefusesNone, false);
});

test("Anthropic 格式：没标明支持思考的模型，关着时不发 thinking；开着时照发", () => {
	const dialect = thinkingDialect("https://relay.example.com", "some-model");
	const input = { budget: 2048, maxTokens: 8192, learnedAdaptive: false };
	assert.deepEqual(anthropicThinkingFields(dialect, { ...input, effort: undefined, supportsThinking: undefined }), {});
	assert.deepEqual(anthropicThinkingFields(dialect, { ...input, effort: undefined, supportsThinking: true }), { thinking: { type: "disabled" } });
	assert.deepEqual(anthropicThinkingFields(dialect, { ...input, effort: "high", supportsThinking: undefined }), { thinking: { type: "enabled", budget_tokens: 2048 } });
	assert.deepEqual(anthropicThinkingFields(dialect, { ...input, effort: "high", supportsThinking: false }), {});
});
