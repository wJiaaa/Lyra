/**
 * A retried reply bills every attempt but occupies the window only once.
 *
 * Each adapter folds the tokens of abandoned attempts into `usage` so the bill is honest. The
 * window, though, holds only the conversation the successful attempt sent: reading the folded
 * figure as context size made one truncated retry double a 10k conversation, and a 24k window
 * compacted for no reason. The same doubled prompt also showed up in the cache diagnosis.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { anthropicMessagesProvider } from "../src/ai/anthropic-messages.ts";
import { openaiChatCompletionsProvider } from "../src/ai/openai-chat-completions.ts";
import { openaiResponsesProvider } from "../src/ai/openai-responses.ts";
import { diagnoseCache } from "../src/runtime/cache-diagnostics.ts";
import { measureTotal } from "../src/tokens.ts";
import type { AssistantMessage, Message, ModelConfig, Provider, ProviderConfig } from "../src/types.ts";

const PROMPT = 10_000;

const model: ModelConfig = {
	id: "qa/m", providerId: "qa", modelId: "m", name: "M",
	contextWindow: 24_000, maxOutputTokens: 4096, supportsThinking: false, supportsImages: false, supportsTools: true,
	pricing: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1.25, source: "manual" },
};

const asked: Message = { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 };

const sse = (frames: string[]) =>
	new Response(frames.join(""), { status: 200, headers: { "content-type": "text/event-stream" } });

async function run(adapter: Provider, api: ProviderConfig["api"], replies: string[][]) {
	const provider: ProviderConfig = { id: "qa", name: "QA", api, baseUrl: "https://api.example.test", apiKey: "k", enabled: true, models: [model] };
	let calls = 0;
	const stream = adapter.stream(provider, model, { systemPrompt: "", messages: [asked], tools: [] }, {
		// The shortest interval the policy allows; one retry is all these need.
		retryPolicy: { network: { retries: 1, strategy: "fixed", intervalMs: 1000, maxIntervalMs: 1000 }, upstream: { retries: 1, strategy: "fixed", intervalMs: 1000, maxIntervalMs: 1000 } },
		fetch: async () => sse(replies[Math.min(calls++, replies.length - 1)]),
	});
	let last: AssistantMessage | undefined;
	for await (const event of stream) {
		if (event.type === "done" || event.type === "error") last = event.message;
	}
	assert.equal(calls, 2, "the first attempt should have failed and been retried once");
	return last!;
}

function assertOneAttemptInWindow(message: AssistantMessage, output: number) {
	assert.equal(message.stopReason, "stop");
	// Billing still counts both prompts.
	assert.equal(message.usage.input, PROMPT * 2);
	// The window holds one.
	assert.deepEqual(measureTotal([asked, message]), { measured: true, tokens: PROMPT + output });
	const [diagnosis] = diagnoseCache([asked, message]);
	assert.equal(diagnosis.prompt, PROMPT);
}

const anthropic = (type: string, rest: Record<string, unknown> = {}) =>
	`event: ${type}\ndata: ${JSON.stringify({ type, ...rest })}\n\n`;

test("Anthropic Messages: a truncated attempt is billed but not counted as context", async () => {
	const start = anthropic("message_start", { message: { id: "msg_01", usage: { input_tokens: PROMPT, output_tokens: 1 } } });
	const half = [
		start,
		anthropic("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
		anthropic("content_block_delta", { index: 0, delta: { type: "text_delta", text: "half" } }),
		anthropic("content_block_stop", { index: 0 }),
	];
	const whole = [
		...half,
		anthropic("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } }),
		anthropic("message_stop"),
	];
	assertOneAttemptInWindow(await run(anthropicMessagesProvider, "anthropic-messages", [half, whole]), 9);
});

const chat = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;

test("Chat Completions: a truncated attempt is billed but not counted as context", async () => {
	const half = [
		chat({ choices: [{ delta: { content: "half" } }] }),
		chat({ choices: [], usage: { prompt_tokens: PROMPT, completion_tokens: 5 } }),
	];
	const whole = [
		chat({ choices: [{ delta: { content: "whole" }, finish_reason: "stop" }] }),
		chat({ choices: [], usage: { prompt_tokens: PROMPT, completion_tokens: 7 } }),
		"data: [DONE]\n\n",
	];
	assertOneAttemptInWindow(await run(openaiChatCompletionsProvider, "openai-chat-completions", [half, whole]), 7);
});

const responses = (type: string, rest: Record<string, unknown>) =>
	`event: ${type}\ndata: ${JSON.stringify({ type, ...rest })}\n\n`;

test("Responses: an empty attempt is billed but not counted as context", async () => {
	const completed = (output: number) => responses("response.completed", { response: { id: "resp_1", usage: { input_tokens: PROMPT, output_tokens: output } } });
	const empty = [completed(3)];
	const whole = [
		responses("response.output_item.done", { output_index: 0, item: { type: "message", id: "m1", role: "assistant", content: [{ type: "output_text", text: "whole" }] } }),
		completed(6),
	];
	assertOneAttemptInWindow(await run(openaiResponsesProvider, "openai-responses", [empty, whole]), 6);
});

/*
 * `response.failed` carries the Response object, usage included (OpenAI's streaming reference).
 * The adapter threw on it without reading that usage, so a failed attempt the provider reported
 * as 101,000 tokens went on the bill as 0 — and once a retry succeeded, it was gone for good.
 */
const FAILED_PROMPT = 101_000;
const failed = responses("response.failed", {
	response: { id: "resp_f", status: "failed", error: { code: "server_error", message: "upstream overloaded" }, usage: { input_tokens: FAILED_PROMPT, output_tokens: 0 } },
});

test("Responses: a failed attempt's reported usage is billed once a retry succeeds", async () => {
	const whole = [
		responses("response.output_item.done", { output_index: 0, item: { type: "message", id: "m1", role: "assistant", content: [{ type: "output_text", text: "whole" }] } }),
		responses("response.completed", { response: { id: "resp_1", usage: { input_tokens: PROMPT, output_tokens: 6 } } }),
	];
	const message = await run(openaiResponsesProvider, "openai-responses", [[failed], whole]);
	assert.equal(message.stopReason, "stop");
	assert.equal(message.usage.input, FAILED_PROMPT + PROMPT, "the bill includes the failed attempt");
	assert.equal(message.lastAttemptUsage?.input, PROMPT, "the window still holds only the attempt that answered");
	assert.ok(message.usage.cost.input > message.lastAttemptUsage!.cost.input, "and it is priced, not just counted");
});

test("Responses: when every attempt fails, the failed message still carries what they cost", async () => {
	const message = await run(openaiResponsesProvider, "openai-responses", [[failed]]);
	assert.equal(message.stopReason, "error");
	assert.equal(message.usage.input, FAILED_PROMPT * 2);
});

test("a message logged before attempts were recorded separately still reads its usage", () => {
	const legacy: AssistantMessage = {
		role: "assistant", content: [{ type: "text", text: "ok" }], api: "anthropic-messages", provider: "qa", model: "m",
		stopReason: "stop", timestamp: 1,
		usage: { input: 500, output: 20, cacheRead: 0, cacheWrite: 0, total: 520, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
	assert.deepEqual(measureTotal([asked, legacy]), { measured: true, tokens: 520 });
});
