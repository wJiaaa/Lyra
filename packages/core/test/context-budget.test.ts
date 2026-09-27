import assert from "node:assert/strict";
import { test } from "node:test";
import { contextMaxTokens, textTokens, toolTokens } from "../src/runtime/context.ts";
import { compactIfNeeded, summaryMessages } from "../src/runtime/compaction.ts";
import { runAgent } from "../src/agent/loop.ts";
import { estimateTokens } from "../src/tokens.ts";
import { emptyUsage, type AssistantMessage, type LlmContext, type ModelConfig, type ProviderConfig } from "../src/types.ts";

const model: ModelConfig = { id: "test/model", providerId: "test", modelId: "model", name: "Test", contextWindow: 32_000, maxOutputTokens: 16_000, supportsThinking: false, supportsImages: false, supportsTools: true };
const provider: ProviderConfig = { id: "test", name: "Test", api: "openai-responses", apiKey: "test", baseUrl: "http://localhost", enabled: true, models: [model] };
const reply = (text = "done"): AssistantMessage => ({ role: "assistant", content: [{ type: "text", text }], provider: "test", model: "model", api: provider.api, usage: emptyUsage(), stopReason: "stop", timestamp: 1 });
const context: LlmContext = { systemPrompt: "rules ".repeat(150), messages: [{ role: "user", content: [{ type: "text", text: "task ".repeat(12_000) }], timestamp: 0 }], tools: [{ name: "read", description: "Read a file", parameters: { type: "object" } }] };

test("first-request output shares the window with instructions, schemas and history", () => {
	const input = estimateTokens(context.messages) + textTokens(context.systemPrompt) + toolTokens(context.tools);
	assert.equal(contextMaxTokens(model, context), model.contextWindow - input - 320);
	assert.equal(contextMaxTokens(model, context, 2000), 2000);
	assert.equal(contextMaxTokens({ ...model, contextWindow: 1_000_000 }, context), 16_000);
});

test("provider usage includes cache and output without counting overhead twice", () => {
	const measured = reply();
	measured.usage = { ...emptyUsage(), input: 5000, cacheRead: 12_000, cacheWrite: 2000, output: 1000 };
	assert.equal(contextMaxTokens(model, { ...context, messages: [measured] }), 11_680);
	const summarized = summaryMessages("short summary", null, provider, model);
	const after = { ...context, messages: [...summarized, measured] };
	assert.equal(contextMaxTokens(model, after), 16_000, "pre-compaction usage is no longer the input size");
});

test("the agent request actually receives the computed output budget", async () => {
	let sent: number | undefined;
	await runAgent({ sessionId: "budget", cwd: "/tmp", provider, model, systemPrompt: context.systemPrompt, messages: context.messages, tools: [], requestApproval: async () => "allow", streamFn: async (input, config) => {
		sent = config.maxTokens;
		assert.equal(sent, contextMaxTokens(model, input));
		return reply();
	} }, async () => {});
	assert.ok(sent && sent < model.maxOutputTokens);
});

test("first-request compaction counts prompt and schema overhead", async () => {
	const messages = Array.from({ length: 24 }, () => reply("details ".repeat(110)));
	const small = { ...model, contextWindow: 10_000, maxOutputTokens: 1000 };
	assert.ok(estimateTokens(messages) < small.contextWindow * 0.8);
	let calls = 0;
	const summary = async function* () { calls++; yield { type: "start" as const, partial: reply("") }; return reply("Summary"); };
	assert.equal(await compactIfNeeded(messages, small, provider, summary), null);
	const result = await compactIfNeeded(messages, small, provider, summary, 3000);
	assert.ok(result?.kept !== undefined);
	assert.equal(calls, 1);
});

test("oversized fixed overhead does not announce a compaction that changed nothing", async () => {
	const messages = [reply("short history")];
	assert.equal(await compactIfNeeded(messages, model, provider, undefined, model.contextWindow), null);
});

test("summary requests use their own prompt budget and ignore retired provider measurements", async () => {
	const summarizer = { ...model, id: "small", contextWindow: 6000, maxOutputTokens: 6000 };
	const messages = Array.from({ length: 20 }, () => ({ ...reply("history ".repeat(180)), usage: { ...emptyUsage(), input: 30_000 } }));
	let sent = false;
	await compactIfNeeded(messages, model, provider, async function* (_provider, active, context, config) {
		sent = true;
		assert.equal(active.id, summarizer.id);
		assert.equal(config?.maxTokens, contextMaxTokens(active, context, 6000, true));
		assert.ok(estimateTokens(context.messages) + textTokens(context.systemPrompt) + config!.maxTokens! + 60 <= active.contextWindow);
		yield { type: "start" as const, partial: reply("") };
		return reply("Summary");
	}, 0, true, undefined, undefined, { provider, model: summarizer });
	assert.ok(sent);
});

test("cancelling during automatic compaction does not commit it or start a model request", async () => {
	const controller = new AbortController();
	const events: string[] = [];
	await runAgent({ sessionId: "abort-compact", cwd: "/tmp", provider, model, signal: controller.signal, systemPrompt: "rules", messages: [reply("history")], tools: [], requestApproval: async () => "allow",
		compact: async () => { controller.abort(); return { messages: [], summary: "too late", kept: 0 }; },
		streamFn: async () => { assert.fail("cancelled turn must not send a request"); },
	}, (event) => { events.push(event.type); });
	assert.ok(!events.includes("compacted"));
	assert.ok(events.includes("agent_end"));
});
