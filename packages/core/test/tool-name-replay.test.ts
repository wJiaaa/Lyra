/**
 * 模型给出的工具名不合规时，那次调用不能把会话拖死。
 *
 * 两种 OpenAI 格式对 `function.name` 要求 `^[a-zA-Z0-9_-]+$` 且非空。模型偶尔给出空名、带空格的名字，
 * gpt-oss 经 vLLM 还会给出 `read<|channel|>commentary`——工具找不到，这一轮照常以「工具不存在」收场，但那
 * 次调用留在了历史里，三种格式都原样回放它的名字，于是之后每一轮都 400，没有学习器认领，会话报废。
 *
 * 修在两头：解析时先 trim（大多数「带空格」到这里就好了），回放时统一规整（只改名字不改 id，配对不受影响）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveTool } from "../src/agent/tool-args.ts";
import { anthropicMessagesProvider } from "../src/ai/anthropic-messages.ts";
import { toAnthropicMessages } from "../src/ai/anthropic-messages-request.ts";
import { openaiChatCompletionsProvider } from "../src/ai/openai-chat-completions.ts";
import { toChatCompletionsMessages } from "../src/ai/openai-chat-completions-request.ts";
import { openaiResponsesProvider } from "../src/ai/openai-responses.ts";
import { toResponsesInput } from "../src/ai/openai-responses-request.ts";
import { toolNameForReplay } from "../src/ai/tool-names.ts";
import { emptyUsage, type AssistantMessage, type Message, type ModelConfig, type Provider, type ProviderConfig, type Tool } from "../src/types.ts";

const WIRE_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

function history(name: string): Message[] {
	const call: AssistantMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id: "call_1", name, arguments: { path: "a.ts" } }],
		api: "openai-chat-completions", provider: "qa", model: "m", usage: emptyUsage(), stopReason: "toolUse", timestamp: 2,
	};
	return [
		{ role: "user", content: [{ type: "text", text: "看看 a.ts" }], timestamp: 1 },
		call,
		{ role: "toolResult", toolCallId: "call_1", toolName: name, content: [{ type: "text", text: "Tool not found" }], isError: true, timestamp: 3 },
		{ role: "user", content: [{ type: "text", text: "继续" }], timestamp: 4 },
	];
}

/** 三种格式各自回放出来的那个工具名和 id。 */
function replayed(name: string): { format: string; name: unknown; id: unknown }[] {
	const messages = history(name);
	const chat = toChatCompletionsMessages("", messages) as { tool_calls?: { id: string; function: { name: string } }[] }[];
	const chatCall = chat.flatMap((m) => m.tool_calls ?? [])[0];
	const responses = toResponsesInput(messages) as { type?: string; name?: string; call_id?: string }[];
	const responsesCall = responses.find((item) => item.type === "function_call");
	const anthropic = toAnthropicMessages(messages).flatMap((m) => m.content).find((b) => b.type === "tool_use");
	return [
		{ format: "chat", name: chatCall?.function.name, id: chatCall?.id },
		{ format: "responses", name: responsesCall?.name, id: responsesCall?.call_id },
		{ format: "anthropic", name: anthropic?.name, id: anthropic?.id },
	];
}

test("回放：空名、带空格、带非法字符的工具名在三种格式里都规整成合规的名字，id 不动", () => {
	for (const bad of ["", "   ", "read file", "read<|channel|>commentary", "mcp.server/tool", "x".repeat(80)]) {
		for (const wire of replayed(bad)) {
			assert.match(String(wire.name), WIRE_NAME, `${wire.format}：${JSON.stringify(bad)} → ${JSON.stringify(wire.name)}`);
			assert.equal(wire.id, "call_1", `${wire.format}：只改名字，配对用的 id 不变`);
		}
	}
});

test("回放：合规的名字原样发，一个字节都不动——缓存前缀不受影响", () => {
	for (const good of ["read", "mcp__github__create_issue", "Bash-2"]) {
		for (const wire of replayed(good)) assert.equal(wire.name, good, wire.format);
	}
});

test("回放规整：空 → unknown_tool，非法字符 → _，两头空白先去掉，截到 64", () => {
	assert.equal(toolNameForReplay(""), "unknown_tool");
	assert.equal(toolNameForReplay("  \n"), "unknown_tool");
	assert.equal(toolNameForReplay(" read "), "read");
	assert.equal(toolNameForReplay("read<|channel|>commentary"), "read__channel__commentary");
	assert.equal(toolNameForReplay("y".repeat(80)).length, 64);
});

test("执行：带空白的名字也能找到那个工具", () => {
	const read = { name: "read" } as Tool;
	assert.equal(resolveTool(new Map([["read", read]]), " read\n"), read);
	assert.equal(resolveTool(new Map([["read", read]]), " Read "), read);
});

// ---------------------------------------------------------------------------
// 解析：三条链上收到的名字先 trim
// ---------------------------------------------------------------------------

const model: ModelConfig = {
	id: "qa/m", providerId: "qa", modelId: "m", name: "M",
	contextWindow: 128_000, maxOutputTokens: 4096, supportsThinking: false, supportsImages: false, supportsTools: true,
};

function sse(frames: string[]): Response {
	return new Response(frames.join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function finalOf(adapter: Provider, frames: string[]): Promise<AssistantMessage> {
	const provider: ProviderConfig = { id: "qa", name: "QA", api: adapter.api, apiKey: "test", baseUrl: "https://example.invalid", enabled: true, models: [model] };
	const stream = adapter.stream(provider, model, { systemPrompt: "", messages: [{ role: "user", content: [{ type: "text", text: "看看" }], timestamp: 1 }], tools: [] }, {
		retryAttempts: 1,
		fetch: async () => sse(frames),
	});
	for (;;) {
		const next = await stream.next();
		if (next.done) return next.value;
	}
}

const callNames = (message: AssistantMessage): string[] => message.content.flatMap((c) => (c.type === "toolCall" ? [c.name] : []));

test("Anthropic：tool_use 的名字两头带空白时，记下来的是去掉空白的", async () => {
	const event = (type: string, rest: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...rest })}\n\n`;
	const final = await finalOf(anthropicMessagesProvider, [
		event("message_start", { message: { id: "msg_1", usage: { input_tokens: 10, output_tokens: 1 } } }),
		event("content_block_start", { index: 0, content_block: { type: "tool_use", id: "toolu_1", name: " read\n", input: {} } }),
		event("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"a.ts"}' } }),
		event("content_block_stop", { index: 0 }),
		event("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } }),
		event("message_stop", {}),
	]);
	assert.deepEqual(callNames(final), ["read"]);
});

test("Chat Completions：function.name 两头带空白时，记下来的是去掉空白的", async () => {
	const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
		`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
	const final = await finalOf(openaiChatCompletionsProvider, [
		chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: " read ", arguments: "" } }] }),
		chunk({ tool_calls: [{ index: 0, function: { arguments: '{"path":"a.ts"}' } }] }),
		chunk({}, "tool_calls"),
		"data: [DONE]\n\n",
	]);
	assert.deepEqual(callNames(final), ["read"]);
});

const responsesFrame = (type: string, rest: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, output_index: 0, ...rest })}\n\n`;

test("Responses：added 里名字是空的、done 里给了，用 done 的回填", async () => {
	const final = await finalOf(openaiResponsesProvider, [
		responsesFrame("response.output_item.added", { item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "", arguments: "" } }),
		responsesFrame("response.function_call_arguments.delta", { item_id: "fc_1", delta: '{"path":"a.ts"}' }),
		responsesFrame("response.output_item.done", { item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: '{"path":"a.ts"}' } }),
		responsesFrame("response.completed", { response: { usage: { input_tokens: 10, output_tokens: 5 } } }),
	]);
	assert.deepEqual(callNames(final), ["read"]);
});

test("Responses：added 里的名字两头带空白时，记下来的是去掉空白的", async () => {
	const final = await finalOf(openaiResponsesProvider, [
		responsesFrame("response.output_item.added", { item: { type: "function_call", id: "fc_1", call_id: "call_1", name: " read ", arguments: "" } }),
		responsesFrame("response.output_item.done", { item: { type: "function_call", id: "fc_1", call_id: "call_1", name: " read ", arguments: '{"path":"a.ts"}' } }),
		responsesFrame("response.completed", { response: { usage: { input_tokens: 10, output_tokens: 5 } } }),
	]);
	assert.deepEqual(callNames(final), ["read"]);
});
