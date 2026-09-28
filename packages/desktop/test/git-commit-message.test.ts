/**
 * Asking the model for a commit message, without talking to a network.
 *
 * The interesting failures are the ones that used to hide behind a fake generator: no model,
 * no patch, a reply wrapped in fences. The stream is injected so this does not spend a token.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_SETTINGS, type AssistantMessage, type Settings, type StreamEvent } from "@plume/core";
import { generateCommitMessage } from "../electron/git-commit-message.ts";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	total: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function settingsWithModel(): Settings {
	return {
		...DEFAULT_SETTINGS,
		defaultModelId: "local/scripted",
		commitLanguage: "en",
		providers: [
			{
				id: "local",
				name: "Local",
				baseUrl: "http://127.0.0.1:9",
				api: "openai-chat-completions",
				apiKey: "not-a-key",
				enabled: true,
				models: [
					{
						id: "local/scripted",
						providerId: "local",
						modelId: "scripted",
						name: "Scripted",
						contextWindow: 32_000,
						maxOutputTokens: 4_096,
						supportsThinking: false,
						supportsImages: false,
						supportsTools: false,
					},
				],
			},
		],
	};
}

function reply(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-chat-completions",
		provider: "local",
		model: "scripted",
		usage,
		stopReason: "stop",
		timestamp: 1,
	};
}

async function* scripted(text: string): AsyncGenerator<StreamEvent, AssistantMessage> {
	const message = reply(text);
	yield { type: "done", message };
	return message;
}

test("no default model is a message, not a crash", async () => {
	const result = await generateCommitMessage("/tmp", {
		settings: DEFAULT_SETTINGS,
		readPatch: async () => ({ patch: "diff", source: "staged" }),
		stream: () => scripted("feat: never"),
	});
	assert.equal(result.ok, false);
	if (!result.ok) assert.match(result.error, /默认模型/);
});

test("an empty working tree refuses rather than inventing a message", async () => {
	const result = await generateCommitMessage("/tmp", {
		settings: settingsWithModel(),
		readPatch: async () => null,
		stream: () => scripted("feat: never"),
	});
	assert.equal(result.ok, false);
	if (!result.ok) assert.match(result.error, /没有/);
});

test("the model's reply is what lands in the field, fences stripped", async () => {
	const result = await generateCommitMessage("/tmp", {
		settings: settingsWithModel(),
		readPatch: async () => ({ patch: "diff --git a/a.ts b/a.ts\n+x", source: "staged" }),
		stream: () => scripted("```\nfeat: add login form\n```"),
	});
	assert.deepEqual(result, { ok: true, message: "feat: add login form" });
});

test("a stream error is reported instead of a leftover scripted sentence", async () => {
	async function* failing(): AsyncGenerator<StreamEvent, AssistantMessage> {
		yield { type: "error", error: "HTTP 401", message: reply("") };
		return reply("");
	}
	const result = await generateCommitMessage("/tmp", {
		settings: settingsWithModel(),
		readPatch: async () => ({ patch: "diff", source: "staged" }),
		stream: () => failing(),
	});
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.error, "HTTP 401");
});
