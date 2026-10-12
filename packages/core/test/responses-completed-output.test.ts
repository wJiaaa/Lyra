/**
 * `response.completed` 里带着整份 `response.output`——流里缺了的项，从那里补。
 *
 * 守规矩的端点上每一项都有 `added` / `done`，那份 output 只是重复；有损的中转上它是唯一完整的一份。
 * 原来只从 completed 里取用量和 id，于是三种形状各坏一样：
 *
 *   - 只发 `output_text.delta` 和 `completed`：deltas 找不到块被扔掉，判成「空回答」。
 *   - 工具调用发了 `function_call_arguments.done`，没发 `output_item.done`：判「没有收尾」反复重试。
 *   - 流里一个字没提的工具调用只在 output 里：静默丢掉，以 `stop` 收场，工具不跑。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { openaiResponsesProvider } from "../src/ai/openai-responses.ts";
import type { AssistantMessage } from "../src/types.ts";

function sse(events: Record<string, unknown>[]): string {
	return events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

const usage = { input_tokens: 10, output_tokens: 5 };

const provider = { id: "responses", name: "responses", baseUrl: "https://example.invalid", api: "openai-responses" as const, apiKey: "test", enabled: true, models: [] };
const model = { modelId: "test-model", contextWindow: 128000, maxOutputTokens: 4096, pricing: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 } };

async function run(body: string): Promise<AssistantMessage> {
	const stream = openaiResponsesProvider.stream(
		provider,
		model,
		{ systemPrompt: "", messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 }], tools: [] },
		// oxlint-disable-next-line no-explicit-any -- 测试里塞一个假 fetch
		{ fetch: (async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })) as any, retryAttempts: 1 },
	);
	while (true) {
		const next = await stream.next();
		if (next.done) return next.value;
	}
}

const message = (text: string) => ({ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text }] });
const call = (id: string, args: string) => ({ type: "function_call", id: `fc_${id}`, call_id: `call_${id}`, name: "bash", arguments: args, status: "completed" });

test("只有 output_text.delta 和 completed：正文从 completed.output 里取", async () => {
	const result = await run(
		sse([
			{ type: "response.output_text.delta", output_index: 0, item_id: "msg_1", delta: "你好" },
			{ type: "response.completed", response: { usage, output: [message("你好")] } },
		]),
	);
	assert.equal(result.stopReason, "stop", result.errorMessage);
	assert.deepEqual(
		result.content.map((c) => c.type === "text" && c.text),
		["你好"],
	);
});

test("参数有 function_call_arguments.done、缺 output_item.done：参数算完整，交给循环", async () => {
	const result = await run(
		sse([
			{ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "bash" } },
			{ type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_a", delta: '{"command":' },
			{ type: "response.function_call_arguments.done", output_index: 0, item_id: "fc_a", arguments: '{"command":"ls"}' },
			{ type: "response.completed", response: { usage } },
		]),
	);
	assert.equal(result.stopReason, "toolUse", result.errorMessage);
	const [tool] = result.content;
	assert.equal(tool.type === "toolCall" && JSON.stringify(tool.arguments), '{"command":"ls"}');
});

test("缺 output_item.done 的调用，参数从 completed.output 里补齐", async () => {
	const result = await run(
		sse([
			{ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "bash" } },
			{ type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_a", delta: '{"command":' },
			{ type: "response.completed", response: { usage, output: [call("a", '{"command":"ls"}')] } },
		]),
	);
	assert.equal(result.stopReason, "toolUse", result.errorMessage);
	assert.deepEqual(
		result.content.map((c) => c.type === "toolCall" && [c.id, c.arguments]),
		[["call_a", { command: "ls" }]],
	);
});

test("流里没出现过的调用只在 completed.output 里：补出来，不静默丢掉", async () => {
	const result = await run(
		sse([
			{ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1" } },
			{ type: "response.output_text.delta", output_index: 0, item_id: "msg_1", delta: "我看看" },
			{ type: "response.output_item.done", output_index: 0, item: message("我看看") },
			{ type: "response.completed", response: { usage, output: [message("我看看"), call("b", '{"command":"pwd"}')] } },
		]),
	);
	assert.equal(result.stopReason, "toolUse", "以 stop 收场的话，工具静默不跑");
	assert.deepEqual(
		result.content.map((c) => (c.type === "text" ? c.text : c.type === "toolCall" ? c.id : c.type)),
		["我看看", "call_b"],
		"流里已经出来的正文不重复",
	);
});

test("流里完整的项，completed.output 再说一遍也不重复", async () => {
	const result = await run(
		sse([
			{ type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1" } },
			{ type: "response.reasoning_summary_text.delta", output_index: 0, item_id: "rs_1", delta: "想" },
			{ type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "rs_1", encrypted_content: "E" } },
			{ type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "bash" } },
			{ type: "response.function_call_arguments.delta", output_index: 1, item_id: "fc_a", delta: '{"command":"ls"}' },
			{ type: "response.output_item.done", output_index: 1, item: call("a", '{"command":"ls"}') },
			{
				type: "response.completed",
				response: { usage, output: [{ type: "reasoning", id: "rs_1", encrypted_content: "E", summary: [{ type: "summary_text", text: "想" }] }, call("a", '{"command":"ls"}')] },
			},
		]),
	);
	assert.equal(result.stopReason, "toolUse");
	assert.deepEqual(
		result.content.map((c) => c.type),
		["thinking", "toolCall"],
	);
});

test("缺了的推理项按 output 里的位置补回去，不排到调用后面", async () => {
	const result = await run(
		sse([
			{ type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "bash" } },
			{ type: "response.output_item.done", output_index: 1, item: call("a", '{"command":"ls"}') },
			{
				type: "response.completed",
				response: { usage, output: [{ type: "reasoning", id: "rs_1", encrypted_content: "E", summary: [{ type: "summary_text", text: "想" }] }, call("a", '{"command":"ls"}')] },
			},
		]),
	);
	assert.deepEqual(
		result.content.map((c) => c.type),
		["thinking", "toolCall"],
	);
	const [thinking] = result.content;
	assert.equal(thinking.type === "thinking" && thinking.encrypted, "E");
});
