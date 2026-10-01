import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../src/config/settings.ts";
import { compactIfNeeded } from "../src/runtime/compaction.ts";
import { AgentSession } from "../src/runtime/session.ts";
import { SideChat } from "../src/runtime/sidechat.ts";
import { SessionStore } from "../src/session/store.ts";
import { emptyUsage, type AssistantMessage, type Message, type ModelConfig, type ProviderConfig } from "../src/types.ts";

const model: ModelConfig = { id: "main/model", providerId: "main", modelId: "model", name: "Main", contextWindow: 2000, maxOutputTokens: 512, supportsThinking: false, supportsImages: false, supportsTools: true };
const summarizer: ModelConfig = { ...model, id: "summary/summarizer", providerId: "summary", modelId: "summarizer", name: "Summary", contextWindow: 8000 };
const provider: ProviderConfig = { id: "main", name: "Main", api: "openai-responses", apiKey: "test", baseUrl: "http://localhost", enabled: true, models: [model] };
const summaryProvider: ProviderConfig = { ...provider, id: "summary", name: "Summary", models: [summarizer] };
const settings = { ...DEFAULT_SETTINGS, providers: [provider, summaryProvider], defaultModelId: model.id, subAgentProfiles: { compact: { modelId: summarizer.id } } };
const question = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
function reply(text: string): AssistantMessage {
	return { role: "assistant", content: [{ type: "text", text }], api: provider.api, provider: provider.id, model: model.modelId, stopReason: "stop", usage: emptyUsage(), timestamp: 2 };
}
const history = () => Array.from({ length: 20 }, (_, index) => index % 2 ? reply("old answer ".repeat(300)) : question("old question ".repeat(300)));

test("automatic main compaction routes the override to the configured provider and model", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ly-compact-route-"));
	const summaries: { provider: string; model: string }[] = [];
	const session = new AgentSession({
		cwd: root, settings, store: new SessionStore(join(root, "sessions")), emit: () => {},
		streamFn: async (context, config) => {
			if (context.systemPrompt?.includes("structured handover summaries")) {
				summaries.push({ provider: config.provider.id, model: config.model.id });
				return reply("Earlier task decisions retained.");
			}
			assert.equal(config.model.id, model.id, "the main request retains its own model");
			return reply("Done");
		},
	});
	t.after(async () => { await session.dispose(); await rm(root, { recursive: true, force: true }); });
	await session.initialize();
	for (const message of history()) await session.log.commit(message);
	await session.prompt([{ type: "text", text: "Continue" }]);
	assert.deepEqual(summaries, [{ provider: summaryProvider.id, model: summarizer.id }]);
});

test("automatic side-chat compaction uses the same configured summarizer", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ly-side-compact-route-"));
	const store = new SessionStore(join(root, "sessions"));
	const main = new AgentSession({ cwd: root, settings, store, meta: await store.create(root, model.id), emit: () => {} });
	t.after(async () => { await main.dispose(); await rm(root, { recursive: true, force: true }); });
	const summaries: { provider: string; model: string }[] = [];
	const side = new SideChat({
		main, settings, emit: () => {},
		streamFn: async (_context, config) => {
			assert.equal(config.model.id, model.id, "side answers still follow the main model");
			return reply("Done");
		},
		summaryStream: async function* (selectedProvider, selectedModel) {
			summaries.push({ provider: selectedProvider.id, model: selectedModel.id });
			const message = reply("Earlier questions retained.");
			yield { type: "done", message };
			return message;
		},
	});
	side.restore(history());
	await side.ask([{ type: "text", text: "Continue" }]);
	assert.deepEqual(summaries, [{ provider: summaryProvider.id, model: summarizer.id }]);
});

for (const target of [{ provider: summaryProvider, model: summarizer }, { provider, model: { ...model, id: "main/other", modelId: "other" } }]) {
	test(`summarizing with ${target.model.id} removes source-model reasoning handles only from the request`, async () => {
		const messages = history();
		const signed: AssistantMessage = { ...reply("Original answer"), content: [
			{ type: "thinking", thinking: "Reasoning text", signature: "source-signature", encrypted: "source-encrypted", redacted: true },
			{ type: "text", text: "Original answer" },
		] };
		messages.splice(1, 0, signed);
		const before = structuredClone(messages);
		let sent: Message[] = [];
		const compacted = await compactIfNeeded(messages, model, provider, async function* (_provider, _model, context) {
			sent = context.messages;
			const message = reply("Summary");
			yield { type: "done", message };
			return message;
		}, 0, true, undefined, undefined, target);
		assert.ok(compacted);
		assert.doesNotMatch(JSON.stringify(sent), /source-signature|source-encrypted/);
		assert.match(JSON.stringify(sent), /Reasoning text/);
		assert.deepEqual(messages, before);
	});
}
