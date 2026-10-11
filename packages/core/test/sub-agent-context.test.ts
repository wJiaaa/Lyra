/**
 * 子代理的上下文用量：跑着的从事件里读，重启前派的从日志里找，算法和主会话那只表同一套。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { runSubAgent } from "../src/runtime/sub-agent.ts";
import { describeSubAgentContext, SubAgentContexts } from "../src/runtime/sub-agent-context.ts";
import { SubAgentRegistry } from "../src/runtime/sub-agents.ts";
import type { AgentDefinition } from "../src/agents-builtin.ts";
import type { AgentEvent } from "../src/agent/events.ts";
import type { SessionRecord } from "../src/session/types.ts";
import type { ModelConfig, ProviderConfig, Settings, Tool } from "../src/types.ts";
import { emptyUsage } from "../src/types.ts";

const MODEL: ModelConfig = { id: "fake/model", providerId: "fake", modelId: "model", name: "Fake", contextWindow: 64_000, maxOutputTokens: 4096, supportsThinking: false, supportsImages: false, supportsTools: true };
/** 派它的那个会话用的模型，窗口故意不一样大：读数要是按它量的，一眼就看得出来。 */
const SESSION_MODEL: ModelConfig = { ...MODEL, id: "fake/session", modelId: "session", contextWindow: 200_000 };
const PROVIDER: ProviderConfig = { id: "fake", name: "Fake", baseUrl: "http://localhost", api: "openai-responses", apiKey: "x", enabled: true, models: [MODEL, SESSION_MODEL] };
const GENERAL: AgentDefinition = { name: "general", description: "通用", systemPrompt: "general", tools: ["read"], source: "builtin" };
const read: Tool = {
	name: "read",
	snippet: "reads",
	description: "reads",
	parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
	async execute() {
		return { content: [{ type: "text", text: "ok" }] };
	},
};

async function dispatch() {
	const registry = new SubAgentRegistry();
	const events: AgentEvent[] = [];
	await runSubAgent(
		{
			sessionId: "s1",
			cwd: "/tmp",
			settings: { thinking: "off" } as unknown as Settings,
			tools: [read],
			skills: [],
			agents: [GENERAL],
			registry,
			requestApproval: async () => "allow",
			emit: async (event) => {
				events.push(event);
			},
			streamFn: async () => ({
				role: "assistant",
				api: "openai-responses",
				provider: "fake",
				model: "model",
				usage: { ...emptyUsage(), input: 5000, output: 20 },
				stopReason: "stop",
				timestamp: Date.now(),
				content: [{ type: "text", text: "在 auth.ts:42" }],
			}),
		},
		{ description: "找认证入口", prompt: "去找", agentType: "general" },
		PROVIDER,
		MODEL,
	);
	const id = registry.list()[0].id;
	return { registry, events, id, detail: registry.detail(id)! };
}

const settings = { providers: [PROVIDER] } as unknown as Settings;
const unread = (): AsyncIterable<SessionRecord> => {
	throw new Error("the log was read for a context already known");
};

test("a sub-agent's reading is its own context, on the model it ran on", async () => {
	const { events, id, detail } = await dispatch();
	const contexts = new SubAgentContexts();
	for (const event of events) contexts.observe(event);
	const seen = await contexts.get(id, unread);
	const result = describeSubAgentContext({ detail, seen, settings, fallback: SESSION_MODEL, mcpNames: new Set() });

	assert.ok(seen.context?.sections?.length, "the prompt's sections travel with it, so skills and instructions are split out");
	assert.equal(result?.limit, 64_000, "measured against the sub-agent's model, not the session's");
	assert.equal(result?.measured, true);
	assert.equal(result?.used, 5020);
	assert.equal(result?.segments.reduce((sum, segment) => sum + segment.tokens, 0), 5020);
	assert.ok((result?.segments.find((segment) => segment.key === "messages")?.tokens ?? 0) > 0);
});

test("one dispatched before a restart is found in the log once, newest stretch first", async () => {
	const { events, id, detail } = await dispatch();
	const sent = events.find((event) => event.type === "subagent_event" && event.event.type === "context");
	assert.ok(sent?.type === "subagent_event");
	const older: AgentEvent = { type: "subagent_event", id, event: { ...sent.event, type: "context", systemPrompt: "an earlier stretch" } as never };
	const sibling: AgentEvent = { type: "subagent_event", id: "someone-else", event: { ...sent.event, type: "context", systemPrompt: "not this one" } as never };
	const log: SessionRecord[] = [older, ...events, sibling].map((event, seq) => ({ seq, ts: seq, type: "event", event }));
	let reads = 0;
	const contexts = new SubAgentContexts();
	const seen = await contexts.get(id, async function* () {
		reads += 1;
		yield* log;
	});

	assert.equal(seen.context?.systemPrompt, sent.event.type === "context" ? sent.event.systemPrompt : null);
	assert.deepEqual(seen.ran, { provider: "fake", model: "model" });
	await contexts.get(id, unread);
	assert.equal(reads, 1, "found once, then remembered");
	assert.equal(describeSubAgentContext({ detail, seen, settings, fallback: SESSION_MODEL, mcpNames: new Set() })?.limit, 64_000);
});

test("a model since removed from settings is measured against the session's", async () => {
	const { events, id, detail } = await dispatch();
	const contexts = new SubAgentContexts();
	for (const event of events) contexts.observe(event);
	const seen = await contexts.get(id, unread);
	const result = describeSubAgentContext({ detail, seen, settings: { providers: [] } as unknown as Settings, fallback: SESSION_MODEL, mcpNames: new Set() });
	assert.equal(result?.limit, 200_000);
});

test("tool schemas from an MCP server are counted as MCP tools", async () => {
	const { events, id, detail } = await dispatch();
	const contexts = new SubAgentContexts();
	for (const event of events) contexts.observe(event);
	const seen = await contexts.get(id, unread);
	const result = describeSubAgentContext({ detail, seen, settings, fallback: SESSION_MODEL, mcpNames: new Set(["read"]) });
	const keys = result?.segments.map((segment) => segment.key) ?? [];
	assert.ok(keys.includes("mcpTools") && !keys.includes("systemTools"));
});
