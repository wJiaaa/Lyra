/**
 * 子代理不派子代理。
 *
 * 只有主对话能派：拆活要看得见全局，派出去的每一个也都该在主会话的名单和闸门里。子代理的工具表里
 * 没有 `task`，往下派的入口也是空的——定义文件里写了 `spawns` 也一样，那个字段已经不读了。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { runSubAgent } from "../src/runtime/sub-agent.ts";
import { buildTurnConfig } from "../src/runtime/turn-config.ts";
import { taskTool, type AgentDefinition } from "../src/tools/task.ts";
import type { AssistantMessage, ModelConfig, ProviderConfig, Settings, Tool, ToolContext } from "../src/types.ts";
import { emptyUsage } from "../src/types.ts";

const MODEL: ModelConfig = {
	id: "fake/model",
	providerId: "fake",
	modelId: "model",
	name: "Fake",
	contextWindow: 100_000,
	maxOutputTokens: 4096,
	supportsThinking: false,
	supportsImages: false,
	supportsTools: true,
};

const PROVIDER: ProviderConfig = {
	id: "fake",
	name: "Fake",
	baseUrl: "http://localhost",
	api: "openai-responses",
	apiKey: "x",
	enabled: true,
	models: [MODEL],
};

const SETTINGS = { thinking: "off", hooks: [], projects: [], maxConcurrentSubAgents: 4 } as unknown as Settings;

function says(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-responses",
		provider: "fake",
		model: "model",
		usage: emptyUsage(),
		stopReason,
		timestamp: Date.now(),
		content: [{ type: "text", text }],
	};
}

test("子代理的工具表里没有 task，也拿不到往下派的入口——定义里写了 spawns 也一样", async () => {
	let handed: ToolContext | null = null;
	const probe: Tool = {
		name: "probe",
		snippet: "reports its context",
		description: "reports its context",
		parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
		summarize: () => "看了一眼",
		async execute(_args, ctx) {
			handed = ctx;
			return { content: [{ type: "text", text: "ok" }] };
		},
	};
	// 旧文件里的写法，原样塞进定义：它必须什么也不改变。
	const boss = { name: "boss", description: "编排者", systemPrompt: "orchestrate", tools: "*", spawns: "*" } as unknown as AgentDefinition;
	const offered: string[][] = [];
	let turn = 0;

	await runSubAgent(
		{
			sessionId: "s1",
			cwd: "/tmp",
			settings: SETTINGS,
			tools: [taskTool as unknown as Tool, probe],
			skills: [],
			agents: [boss],
			requestApproval: async () => "allow",
			emit: async () => {},
			streamFn: async (context) => {
				offered.push(context.tools.map((tool) => tool.name));
				return turn++ === 0
					? { ...says("", "toolUse"), content: [{ type: "toolCall", id: "c1", name: "probe", arguments: {}, argumentsText: "{}" }] }
					: says("好了");
			},
		},
		{ description: "编排", prompt: "去", agentType: "boss" },
		PROVIDER,
		MODEL,
	);

	assert.ok(offered.length > 0, "the sub-agent never made a request");
	for (const tools of offered) assert.ok(!tools.includes("task"), `task was offered: ${tools.join(", ")}`);
	assert.ok(offered[0].includes("probe"), "the comparison must not pass on an empty tool list");
	assert.ok(handed, "the probe tool never ran");
	assert.equal((handed as ToolContext).spawnSubAgent, undefined);
});

test("主会话照样派得出去", () => {
	const config = buildTurnConfig(
		{
			sessionId: "s1",
			cwd: "/tmp",
			provider: PROVIDER,
			model: MODEL,
			settings: SETTINGS,
			state: new Map(),
			tools: [taskTool as unknown as Tool],
			skills: [],
			agents: [],
			requestApproval: async () => "allow",
			emit: async () => {},
			beforeToolCall: undefined,
			afterToolCall: undefined,
			drainSteering: undefined,
		} as unknown as Parameters<typeof buildTurnConfig>[0],
		{ systemPrompt: "", messages: [], tools: [taskTool as unknown as Tool], cwd: "/tmp" },
		"",
	);
	assert.equal(typeof config.tools.env.spawnSubAgent, "function");
});
