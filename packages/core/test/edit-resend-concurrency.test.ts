import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../src/config/settings.ts";
import { AgentSession } from "../src/runtime/session.ts";
import { SessionStore } from "../src/session/store.ts";
import { emptyUsage, type AssistantMessage, type ModelConfig, type ProviderConfig } from "../src/types.ts";

test("editing waits for prompt acceptance before truncating and running the replacement", async () => {
	const root = await mkdtemp(join(tmpdir(), "ly-edit-accept-"));
	const model: ModelConfig = { id: "test/model", providerId: "test", modelId: "model", name: "Test", contextWindow: 128000, maxOutputTokens: 4096, supportsThinking: false, supportsImages: false, supportsTools: true };
	const provider: ProviderConfig = { id: "test", name: "Test", api: "openai-responses", apiKey: "test", baseUrl: "http://localhost", enabled: true, models: [model] };
	const paused = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	let truncateRequested = false;
	class ObservedStore extends SessionStore {
		override truncateFrom(...args: Parameters<SessionStore["truncateFrom"]>) {
			truncateRequested = true;
			return super.truncateFrom(...args);
		}
	}
	const store = new ObservedStore(join(root, "sessions"));
	const seen: string[] = [];
	const session = new AgentSession({
		cwd: root, store,
		settings: { ...DEFAULT_SETTINGS, providers: [provider], defaultModelId: model.id },
		emit: async (event) => {
			if (event.type === "message_start" && event.message.role === "user" && !truncateRequested) {
				started.resolve();
				await paused.promise;
			}
		},
		streamFn: async (context): Promise<AssistantMessage> => {
			seen.push(JSON.stringify(context.messages));
			return { role: "assistant", content: [{ type: "text", text: "Replied" }], api: provider.api, provider: provider.id, model: model.modelId, stopReason: "stop", usage: emptyUsage(), timestamp: Date.now() };
		},
	});
	await session.initialize();
	const original = session.prompt([{ type: "text", text: "Original question" }]);
	await started.promise;
	const editing = session.editAndResend(0, [{ type: "text", text: "Replacement question" }]);
	const truncatedBeforeAcceptance = truncateRequested;
	paused.resolve();
	try {
		await Promise.all([original, editing]);
		assert.equal(truncatedBeforeAcceptance, false, "the accepted prompt still owns its history until its lifecycle settles");
		assert.equal(seen.length, 1);
		assert.match(seen[0], /Replacement question/);
		assert.doesNotMatch(seen[0], /Original question/);
		assert.equal(session.running, false);
		const loaded = await store.load(session.meta.id);
		assert.deepEqual(loaded?.messages, session.messages);
	} finally {
		await session.dispose();
		await rm(root, { recursive: true, force: true });
	}
});
