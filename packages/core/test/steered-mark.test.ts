/**
 * 循环接进去的话带着 `steered`，开这次运行的那句不带。
 *
 * 界面靠它分辨一条送达是把空闲的会话叫醒了，还是插在一轮中间——没有这个标记，插在中间的后台
 * 命令结果被画成新的一轮，一段没断过的工作被切成几段。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { runAgent } from "../src/agent/loop.ts";
import { runConfig } from "./run-config.ts";
import { emptyUsage, type AssistantMessage, type Message, type ModelConfig, type ProviderConfig, type Tool } from "../src/types.ts";

const MODEL: ModelConfig = { id: "fake/model", providerId: "fake", modelId: "model", name: "Fake", contextWindow: 100_000, maxOutputTokens: 4096, supportsThinking: false, supportsImages: false, supportsTools: true };
const PROVIDER: ProviderConfig = { id: "fake", name: "Fake", baseUrl: "http://localhost", api: "openai-responses", apiKey: "x", enabled: true, models: [MODEL] };

function says(text: string): AssistantMessage {
	return { role: "assistant", api: "openai-responses", provider: "fake", model: "model", usage: emptyUsage(), stopReason: "stop", timestamp: Date.now(), content: [{ type: "text", text }] };
}

const probes = (): AssistantMessage => ({ ...says(""), stopReason: "toolUse", content: [{ type: "toolCall", id: "c1", name: "noop", arguments: {}, argumentsText: "{}" }] });

const NOOP: Tool = { name: "noop", snippet: "noop", description: "noop", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "ok" }] }) };

test("插进这次运行的消息打上 steered，开这次运行的那句不打", async () => {
	const opener: Message = { role: "user", content: [{ type: "text", text: "开始" }], timestamp: 1 };
	const delivery: Message = { role: "user", synthetic: true, delivery: [{ id: "j1", kind: "job", agent: "", description: "render", status: "done" }], content: [{ type: "text", text: "（运行时送达）" }], timestamp: 2 };
	const queue: Message[] = [];
	const script = [probes(), says("做完了")];
	const ended: Message[] = [];
	await runAgent(runConfig({
		session: { sessionId: "t", systemPrompt: "", messages: [opener] },
		model: {
			model: MODEL, provider: PROVIDER,
			streamFn: async () => {
				const next = script.shift() ?? says("多出来的一轮");
				// 第一轮还在调工具时，后台命令结束了。
				if (next.stopReason === "toolUse") queue.push(delivery);
				return next;
			},
		},
		tools: { available: [NOOP], env: { cwd: "/tmp" }, requestApproval: async () => "allow" },
		control: { drainSteering: () => queue.splice(0, queue.length) },
	}), async (event) => {
		if (event.type === "message_end") ended.push(event.message);
	});

	const injected = ended.find((message) => message.role === "user" && message.delivery);
	assert.equal(injected, delivery, "接进去的是同一个对象：日志和子代理登记簿都按身份去重");
	assert.equal(injected?.role === "user" && injected.steered, true);
	assert.equal(opener.role === "user" && opener.steered, undefined, "开这次运行的那句是新的一次，不是插进来的");
});
