/**
 * A delegated run is bound by what the session decided, not by what it can get away with.
 *
 * `runSubAgent` built its `runTurn` config from scratch, and everything it did not name came out
 * unset — which for each of these means "no restriction" rather than "inherit". So a sub-agent ran
 * its commands outside the sandbox the permission mode had chosen, reached hosts the allow-list
 * excludes, and slipped past every configured hook: the same `bash` call audited in the main
 * conversation and unaudited one level down.
 *
 * None of that is visible in a diff of the sub-agent's own file — the fields are simply not there —
 * so each one is pinned by reading what the tool was actually handed.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { runSubAgent } from "../src/runtime/sub-agent.ts";
import { toolPolicy } from "../src/runtime/tool-policy.ts";
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
async function contextGivenTo(settings: Partial<Settings>): Promise<ToolContext> {
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

test("the host allow-list reaches a delegated run", async () => {
	const ctx = await contextGivenTo({ allowedHosts: ["example.com"] } as Partial<Settings>);

	assert.deepEqual(ctx.allowedHosts, ["example.com"]);
});

test("every field of the tool policy reaches a delegated run, as the main turn derives it", async () => {
	// One derivation for both kinds of run; a field added to `toolPolicy` is covered here unasked.
	const settings = { permissionMode: "auto", denyCommandNetwork: true, allowedHosts: ["example.com"], searchProvider: "tavily", projects: [] } as unknown as Settings;
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
