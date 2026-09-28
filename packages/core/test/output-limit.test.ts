/**
 * 回复撞上输出上限：接着写，或把一次写不完的拆开；一再撞上就停下说清楚，不空耗轮数。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { runAgent } from "../src/agent/loop.ts";
import { emptyUsage, type AssistantMessage, type Message, type ModelConfig, type ProviderConfig, type Tool } from "../src/types.ts";

const model: ModelConfig = { id: "t/m", providerId: "t", modelId: "m", name: "M", contextWindow: 100_000, maxOutputTokens: 256, supportsThinking: false, supportsImages: false, supportsTools: true };
const provider: ProviderConfig = { id: "t", name: "T", baseUrl: "http://127.0.0.1:1", api: "openai-chat-completions", apiKey: "x", enabled: true, models: [model] };
const reply = (stopReason: AssistantMessage["stopReason"], content: AssistantMessage["content"]): AssistantMessage => ({
	role: "assistant", content, api: provider.api, provider: provider.id, model: model.modelId, stopReason, usage: emptyUsage(), timestamp: Date.now(),
});
const user: Message = { role: "user", content: [{ type: "text", text: "写一篇长文" }], timestamp: 1 };

async function run(replies: AssistantMessage[], tools: Tool[] = []) {
	const sent: Message[][] = [];
	const events: { type: string; message?: string }[] = [];
	const result = await runAgent(
		{ sessionId: "s", cwd: "/tmp", provider, model, systemPrompt: "", tools, messages: [user], streamFn: async (context) => {
			sent.push([...context.messages]);
			const next = replies.shift();
			if (!next) throw new Error("no more replies");
			return next;
		} },
		async (event) => { events.push(event as { type: string; message?: string }); },
	);
	return { result, sent, events };
}

test("a text reply cut off by the output limit continues from where it stopped", async () => {
	const { result, sent } = await run([reply("length", [{ type: "text", text: "前半段" }]), reply("stop", [{ type: "text", text: "后半段" }])]);
	assert.equal(result.reason, "done");
	assert.equal(sent.length, 2, "接着写了一次，而不是当作答完");
	const resume = sent[1].at(-1);
	assert.equal(resume?.role, "user");
	assert.equal(resume?.role === "user" && resume.synthetic, true, "是运行时在说话，界面不画成人说的");
	assert.match(JSON.stringify(resume?.content), /输出长度上限/);
});

test("a reply that keeps hitting the limit stops after a bounded number of continuations and says so", async () => {
	const { result, sent, events } = await run(Array.from({ length: 10 }, () => reply("length", [{ type: "text", text: "……" }])));
	assert.equal(sent.length, 4, "三次接着写之后停下");
	assert.equal(result.reason, "done");
	assert.ok(events.some((event) => event.type === "notice" && /输出长度上限/.test(event.message ?? "")));
});

test("tool calls cut off mid-arguments are not run, ask for smaller pieces, and stop when it keeps happening", async () => {
	let ran = 0;
	const write: Tool = { name: "write", description: "w", parameters: { type: "object", properties: {} }, execute: async () => { ran++; return { content: [{ type: "text", text: "ok" }] }; } };
	const cut = () => reply("length", [{ type: "toolCall", id: `c${Math.random()}`, name: "write", arguments: {}, argumentsText: "{\"content\":\"…" }]);
	const { result, sent } = await run([cut(), cut(), cut(), cut(), cut()], [write]);
	assert.equal(ran, 0, "参数可能不完整的调用不执行");
	assert.match(JSON.stringify(sent[1].at(-1)?.content), /in parts/, "失败说明里要它拆开写");
	assert.equal(sent.length, 4);
	assert.equal(result.reason, "error");
	assert.match(result.error ?? "", /输出长度上限/);
});
