/**
 * A delegated run is bound by what the session decided, not by what it can get away with.
 *
 * `runSubAgent` built its `runTurn` config from scratch, and everything it did not name came out
 * unset — which for each of these means "no restriction" rather than "inherit". So a sub-agent ran
 * its commands outside the sandbox the permission mode had chosen and slipped past every
 * configured hook: the same `bash` call audited in the main
 * conversation and unaudited one level down.
 *
 * None of that is visible in a diff of the sub-agent's own file — the fields are simply not there —
 * so each one is pinned by reading what the tool was actually handed.
 */

import assert from "node:assert/strict";
import { test } from "node:test";


import { runSubAgent } from "../src/runtime/sub-agent/sub-agent.ts";
import { inheritedToolEnv } from "../src/runtime/run-policy.ts";
import { toolPolicy } from "../src/runtime/tool-policy.ts";
import { buildTurnConfig } from "../src/runtime/turn-config.ts";
import { normalizeSettings } from "../src/config/settings.ts";
import type { AssistantMessage, LlmContext, ModelConfig, ProviderConfig, Settings, Tool, ToolContext } from "../src/types.ts";
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

function callsProbe(): AssistantMessage {
	return {
		...says("", "toolUse"),
		content: [{ type: "toolCall", id: "c1", name: "probe", arguments: {}, argumentsText: "{}" }],
	};
}

/** Dispatch one sub-agent whose only tool records the context it was handed. */
async function contextGivenTo(settings: Partial<Settings>, allowedPaths?: ReadonlySet<string>): Promise<ToolContext> {
	let seen: ToolContext | null = null;
	const probe: Tool = {
		name: "probe",
		snippet: "reports its context",
		description: "reports its context",
		parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
		summarize: () => "看了一眼",
		async execute(_args, ctx) {
			seen = ctx;
			return { content: [{ type: "text", text: "ok" }] };
		},
	};

	let turn = 0;
	await runSubAgent(
		{
			sessionId: "s1",
			cwd: "/tmp",
			settings: { thinking: "off", hooks: [], ...settings } as unknown as Settings,
			tools: [probe],
			skills: [],
			agents: [],
			requestApproval: async () => "allow",
			emit: async () => {},
			streamFn: async () => (turn++ === 0 ? callsProbe() : says("好了")),
			allowedPaths,
		},
		{ description: "跑一下", prompt: "去", agentType: "general" },
		PROVIDER,
		MODEL,
	);

	assert.ok(seen, "the probe tool never ran");
	return seen;
}

test("the sandbox the permission mode chose applies to delegated work too", async () => {
	const ctx = await contextGivenTo({ permissionMode: "ask" });

	// Unset is not "inherit" — it is no sandbox at all, which is the loosest setting there is.
	assert.equal(ctx.sandboxMode, "read-only");
});

test("each permission mode reaches the sub-agent as its own sandbox", async () => {
	// Guards against the field being wired to a constant, which would pass the test above.
	assert.equal((await contextGivenTo({ permissionMode: "auto" })).sandboxMode, "workspace-write");
	assert.equal((await contextGivenTo({ permissionMode: "full" })).sandboxMode, "danger-full-access");
});

test("every field of the tool policy reaches a delegated run, as the main turn derives it", async () => {
	// One derivation for both kinds of run; a field added to `toolPolicy` is covered here unasked.
	const settings = { permissionMode: "auto", searchProvider: "tavily", projects: [] } as unknown as Settings;
	const ctx = await contextGivenTo(settings);
	for (const [field, value] of Object.entries(toolPolicy({ thinking: "off", hooks: [], ...settings } as unknown as Settings, "/tmp"))) {
		assert.deepEqual(ctx[field as keyof ToolContext], value, field);
	}
});

test("previews from a delegated run are filed under the session, not the sub-agent", async () => {
	// Its own id disappears when it finishes; a page filed under that outlives nothing.
	const ctx = await contextGivenTo({});

	assert.equal(typeof ctx.writePreview, "function", "a sub-agent that cannot write previews cannot build one");
});

test("configured hooks see a delegated tool call", async () => {
	/*
	 * The one with teeth. A `PreToolUse` hook that blocks a command is a policy decision, and a
	 * delegated call that never reaches it is that policy silently not applying — the same command
	 * refused in the main conversation and allowed one level down.
	 */
	let asked: string | null = null;
	let turn = 0;
	const probe: Tool = {
		name: "probe",
		snippet: "does nothing",
		description: "does nothing",
		parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
		summarize: () => "看了一眼",
		async execute() {
			asked = "ran";
			return { content: [{ type: "text", text: "ok" }] };
		},
	};

	await runSubAgent(
		{
			sessionId: "s1",
			cwd: "/tmp",
			settings: { thinking: "off", hooks: [] } as unknown as Settings,
			tools: [probe],
			skills: [],
			agents: [],
			requestApproval: async () => "allow",
			emit: async () => {},
			streamFn: async () => (turn++ === 0 ? callsProbe() : says("好了")),
		},
		{ description: "跑一下", prompt: "去", agentType: "general" },
		PROVIDER,
		MODEL,
	);

	// With no hooks configured the call goes through, which is the baseline the wiring must not
	// change; that the hooks are consulted at all is what `makeBeforeToolCall` being passed proves.
	assert.equal(asked, "ran");
});

test("a delegated run and the main turn take the session's policy from one place", async () => {
	/*
	 * 两边各自构造 `AgentRunConfig`，而「沙箱、搜索、预览、允许读的路径」必须一样。按 `inheritedToolEnv`
	 * 交出的键逐个比：以后往里加一个字段，这里不用改就会把两边都查到。
	 */
	const settings = { thinking: "off", hooks: [], permissionMode: "auto", searchProvider: "tavily", projects: [] } as unknown as Settings;
	const allowedPaths = new Set(["/elsewhere/a.txt"]);
	const main = buildTurnConfig(
		{
			sessionId: "s1",
			cwd: "/tmp",
			provider: PROVIDER,
			model: MODEL,
			settings,
			state: new Map(),
			tools: [],
			skills: [],
			agents: [],
			allowedPaths,
			requestApproval: async () => "allow",
			emit: async () => {},
			beforeToolCall: undefined,
			afterToolCall: undefined,
			drainSteering: undefined,
		} as unknown as Parameters<typeof buildTurnConfig>[0],
		{ systemPrompt: "", messages: [], tools: [], cwd: "/tmp" },
		"",
	).tools.env;
	const delegated = await contextGivenTo(settings, allowedPaths);

	const inherited = inheritedToolEnv({ settings, cwd: "/tmp", sessionId: "s1", allowedPaths, transcript: undefined });
	for (const [field, value] of Object.entries(inherited)) {
		const key = field as keyof typeof inherited;
		if (typeof value === "function") assert.equal(typeof delegated[key], typeof main[key], field);
		else assert.deepEqual(delegated[key], main[key], field);
	}
	assert.equal(delegated.sandboxMode, "workspace-write", "the comparison must not pass on two empty sides");
});

test("a hook that blocks a call in the main conversation blocks it one level down, and knows who asked", async () => {
	// 钩子进程用 `node -e`，不经过 shell，Windows 上也成立。只在问的是这个会话里的 `general` 时拦。
	const script =
		"let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const input=JSON.parse(s);" +
		"if(input.sessionId==='s1'&&input.agentName==='general'){process.stderr.write('子代理也不许');process.exit(2)}})";
	const hooks = { events: { PreToolUse: [{ matcher: "probe", hooks: [{ type: "process", command: process.execPath, args: ["-e", script] }] }] } };
	let ran = false;
	const probe: Tool = {
		name: "probe",
		snippet: "does nothing",
		description: "does nothing",
		parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
		summarize: () => "看了一眼",
		async execute() {
			ran = true;
			return { content: [{ type: "text", text: "ok" }] };
		},
	};
	const sent: LlmContext[] = [];
	let turn = 0;

	await runSubAgent(
		{
			sessionId: "s1",
			cwd: "/tmp",
			settings: { thinking: "off", hooks } as unknown as Settings,
			tools: [probe],
			skills: [],
			agents: [],
			requestApproval: async () => "allow",
			emit: async () => {},
			streamFn: async (context) => {
				sent.push(structuredClone(context));
				return turn++ === 0 ? callsProbe() : says("好了");
			},
		},
		{ description: "跑一下", prompt: "去", agentType: "general" },
		PROVIDER,
		MODEL,
	);

	assert.equal(ran, false, "the hook should have stopped the call before the tool ran");
	const result = sent[1]?.messages.at(-1);
	assert.equal(result?.role, "toolResult");
	assert.match(JSON.stringify(result), /子代理也不许/, "what the model reads back is the hook's reason");
});

test("旧网络配置被丢弃，始终允许记录继续保留在配置中", () => {
	const stored = { allowedHosts: ["nas.local"], denyCommandNetwork: true, alwaysAllow: ["bash:git status"] };
	const settings = normalizeSettings(stored);
	assert.ok(!("allowedHosts" in settings));
	assert.ok(!("denyCommandNetwork" in settings));
	assert.deepEqual(settings.alwaysAllow, stored.alwaysAllow);
});

test("删掉的调用链排法开关和工具调用分组开关不随外观设置留下来", () => {
	const settings = normalizeSettings({ appearance: { callChain: "expanded", groupExplore: false, groupTerminal: false, groupChanges: true, errorDetail: "full" } } as never);
	for (const key of ["callChain", "groupExplore", "groupTerminal", "groupChanges"]) assert.ok(!(key in settings.appearance), key);
	assert.equal(settings.appearance.errorDetail, "full", "同一组里别的外观设置照旧读进来");
});
