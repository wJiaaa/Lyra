/**
 * 步数上限那一轮收尾时的插话，不能丢。
 *
 * 循环在最后一轮的收尾处把插话取走（`carried`）、`continue`，而循环顶上先判上限、直接
 * `finish("max_turns")`——那句话既不在转录里，也不在队列里。主会话 200 轮、子代理检查点 60 轮，
 * 同一个坑。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { runAgent } from "../src/agent/loop.ts";
import { runSubAgent } from "../src/runtime/sub-agent.ts";
import { SubAgentRegistry } from "../src/runtime/sub-agents.ts";
import type { AgentDefinition } from "../src/tools/task.ts";
import { emptyUsage, type AssistantMessage, type Message, type ModelConfig, type ProviderConfig, type Settings, type Tool } from "../src/types.ts";

const MODEL: ModelConfig = { id: "fake/model", providerId: "fake", modelId: "model", name: "Fake", contextWindow: 100_000, maxOutputTokens: 4096, supportsThinking: false, supportsImages: false, supportsTools: true };
const PROVIDER: ProviderConfig = { id: "fake", name: "Fake", baseUrl: "http://localhost", api: "openai-responses", apiKey: "x", enabled: true, models: [MODEL] };

function says(text: string): AssistantMessage {
	return { role: "assistant", api: "openai-responses", provider: "fake", model: "model", usage: emptyUsage(), stopReason: "stop", timestamp: Date.now(), content: [{ type: "text", text }] };
}

function probes(): AssistantMessage {
	return { ...says(""), stopReason: "toolUse", content: [{ type: "toolCall", id: `c${Math.random().toString(36).slice(2, 7)}`, name: "noop", arguments: {}, argumentsText: "{}" }] };
}

const NOOP: Tool = { name: "noop", snippet: "noop", description: "noop", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "ok" }] }) };

const steer = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });

test("循环：最后一轮收尾时到的插话留在队列里，不被取走丢掉", async () => {
	const queue: Message[] = [];
	const script = [probes(), says("做完了")];
	const result = await runAgent({
		sessionId: "t", cwd: "/tmp", model: MODEL, provider: PROVIDER, systemPrompt: "", tools: [NOOP],
		messages: [steer("开始")], maxTurns: 2,
		requestApproval: async () => "allow",
		drainSteering: () => queue.splice(0, queue.length),
		streamFn: async () => {
			const next = script.shift() ?? says("多出来的一轮");
			// 第二轮（也是最后一轮）正在说话时，人插了一句。
			if (script.length === 0) queue.push(steer("顺便把测试也跑一下"));
			return next;
		},
	}, async () => {});

	assert.equal(result.reason, "done", "模型这一轮本来就说完了");
	assert.equal(queue.length, 1, "那句插话还在队列里，由宿主接着发");
});

test("子代理：检查点那一轮收尾时的插话，接着跑一段送进去", async () => {
	const registry = new SubAgentRegistry();
	const agent = { name: "short", description: "一轮就到检查点", systemPrompt: "do", tools: "*", maxTurns: 1 } as AgentDefinition;
	const sent: Message[][] = [];
	const answer = await runSubAgent(
		{
			sessionId: "s1", cwd: "/tmp",
			settings: { thinking: "off", maxConcurrentSubAgents: 4 } as unknown as Settings,
			tools: [], skills: [], agents: [agent], registry,
			requestApproval: async () => "allow",
			emit: async () => {},
			streamFn: async (context) => {
				sent.push([...context.messages]);
				if (sent.length === 1) {
					registry.steer(registry.list()[0].id, "再补一句：结论写短一点");
					return says("初稿");
				}
				return says("收到，短版结论");
			},
		},
		{ description: "d", prompt: "开始", agentType: "short" },
		PROVIDER,
		MODEL,
		"",
	);

	assert.equal(sent.length, 2, "为那句插话多跑了一段");
	assert.ok(JSON.stringify(sent[1]).includes("结论写短一点"), "插话进了它的上下文");
	assert.match(answer.text, /短版结论/);
});
