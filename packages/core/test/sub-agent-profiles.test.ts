import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS, normalizeSettings } from "../src/config/settings.ts";
import { normalizeSubAgentProfiles, parseModelRef, resolveSubAgentModel } from "../src/config/model-choice.ts";
import { runSubAgent } from "../src/runtime/sub-agent.ts";
import { THINKING_LEVELS, thinkingOptionsFor } from "../src/ai/thinking-options.ts";
import { BUILTIN_AGENTS, taskTool } from "../src/tools/task.ts";
import { emptyUsage, type AssistantMessage, type ModelConfig, type ProviderConfig, type Settings } from "../src/types.ts";

const model: ModelConfig = { id: "a/same", providerId: "a", modelId: "gpt-5.6-sol", name: "Same name", contextWindow: 128000, maxOutputTokens: 4096, supportsThinking: true, thinkingOptions: thinkingOptionsFor(THINKING_LEVELS), supportsImages: false, supportsTools: true };
const provider: ProviderConfig = { id: "a", name: "A", api: "openai-responses", apiKey: "test", baseUrl: "http://localhost", enabled: true, models: [model] };
const second: ProviderConfig = { ...provider, id: "b", name: "B", models: [{ ...model, providerId: "b", id: "b/same" }] };
const settings: Settings = { ...DEFAULT_SETTINGS, providers: [provider, second], defaultModelId: model.id, thinking: "low" };
const fallback = { model, provider };
const explore = BUILTIN_AGENTS.find((agent) => agent.name === "explore");
assert.ok(explore);

test("local profile selects the exact provider, outranks the definition, and inherits when removed", () => {
	const chosen = resolveSubAgentModel({ ...settings, subAgentProfiles: { explore: { modelId: "b/same", thinking: "ultra" } } }, explore, fallback);
	assert.equal(chosen.provider.id, "b"); assert.equal(chosen.model.id, "b/same"); assert.equal(chosen.thinking, "ultra");
	assert.equal(resolveSubAgentModel(settings, explore, fallback).provider.id, "a");
	assert.equal(resolveSubAgentModel(settings, { ...explore, model: "a/same:xhigh" }, fallback).thinking, "xhigh");
	for (const level of ["minimal", "xhigh", "max", "ultra"]) assert.deepEqual(parseModelRef(`a/same:${level}`), { id: "a/same", thinking: level });
	assert.deepEqual(parseModelRef("kimi:256k"), { id: "kimi:256k" });
});

test("disabled and deleted explicit models fail visibly rather than using a different paid provider", () => {
	const configured = { ...settings, subAgentProfiles: { explore: { modelId: "b/same" } } };
	assert.throws(() => resolveSubAgentModel({ ...configured, providers: [provider, { ...second, enabled: false }] }, explore, fallback), /不可用/);
	assert.throws(() => resolveSubAgentModel({ ...configured, providers: [provider] }, explore, fallback), /重新选择/);
});

test("thinking follows model capability, including custom levels and non-reasoning models", () => {
	const basic: ModelConfig = { ...model, modelId: "gemini-3", thinkingOptions: undefined };
	const basicSettings = { ...settings, thinking: "ultra", providers: [{ ...provider, models: [basic] }] };
	// 继承来的档位模型没有时就近取，「极致」落到默认四档里最深的那档。
	assert.equal(resolveSubAgentModel(basicSettings, explore, { provider, model: basic }).thinking, "high");
	assert.throws(() => resolveSubAgentModel({ ...basicSettings, subAgentProfiles: { explore: { thinking: "ultra" } } }, explore, { provider, model: basic }), /不支持思考等级/);
	const custom = { ...model, thinkingOptions: [{ id: "deep-custom", label: "Custom", detail: "Custom effort" }] };
	assert.equal(resolveSubAgentModel({ ...settings, subAgentProfiles: { explore: { thinking: "deep-custom" } } }, explore, { provider, model: custom }).thinking, "deep-custom");
	assert.equal(resolveSubAgentModel(settings, explore, { provider, model: { ...model, supportsThinking: false } }).thinking, "off");
});

test("normalization retains valid overrides and discards malformed imported settings", () => {
	const profiles = normalizeSubAgentProfiles({ explore: { modelId: " b/same ", thinking: " high " }, review: { modelId: 42 }, general: null, bad: [], "": { modelId: "a/same" } });
	assert.deepEqual(profiles, { explore: { modelId: "b/same", thinking: "high" } });
	assert.deepEqual(normalizeSettings({ ...settings, subAgentProfiles: profiles }).subAgentProfiles, profiles);
	assert.deepEqual(normalizeSubAgentProfiles(["bad"]), {});
});

test("real dispatch uses configured provider and thinking on the wire configuration", async () => {
	let seen = false;
	await runSubAgent({ sessionId: "profile-test", cwd: process.cwd(), settings: { ...settings, subAgentProfiles: { explore: { modelId: "b/same", thinking: "ultra" } } }, tools: [], skills: [], agents: [explore], requestApproval: async () => "once", emit: () => {}, streamFn: async (_context, config) => {
		seen = true;
		assert.equal(config.provider.id, "b"); assert.equal(config.model.id, "b/same"); assert.equal(config.thinking, "ultra");
		const response: AssistantMessage = { role: "assistant", content: [{ type: "text", text: "Done" }], api: provider.api, provider: "b", model: model.modelId, usage: emptyUsage(), stopReason: "stop", timestamp: 1 };
		return response;
	} }, { description: "Read", prompt: "Read", agentType: "explore" }, provider, model);
	assert.equal(seen, true);
});

test("nested dispatch resolves updated preferences without changing the already running parent's model", async () => {
	let current = settings;
	let turns = 0;
	const seen: string[] = [];
	const boss = { ...BUILTIN_AGENTS[0], name: "boss", spawns: ["explore"] };
	await runSubAgent({ sessionId: "nested-profile", cwd: process.cwd(), settings, getSettings: () => current, tools: [taskTool], skills: [], agents: [boss, explore], requestApproval: async () => "once", emit: () => {}, streamFn: async (_context, config) => {
		seen.push(`${config.provider.id}:${config.thinking}`);
		const response: AssistantMessage = { role: "assistant", content: [{ type: "text", text: "Done" }], api: config.provider.api, provider: config.provider.id, model: config.model.modelId, usage: emptyUsage(), stopReason: "stop", timestamp: ++turns };
		if (turns === 1) {
			current = { ...settings, subAgentProfiles: { explore: { modelId: "b/same", thinking: "ultra" }, boss: { modelId: "b/same", thinking: "high" } } };
			return { ...response, stopReason: "toolUse", content: [{ type: "toolCall", id: "nested", name: "task", arguments: { description: "Read", prompt: "Read", subagent_type: "explore" } }] };
		}
		return response;
	} }, { description: "Delegate", prompt: "Delegate", agentType: "boss" }, provider, model);
	assert.deepEqual(seen, ["a:low", "b:ultra", "a:low"]);
});
