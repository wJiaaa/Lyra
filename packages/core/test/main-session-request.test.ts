/**
 * What the main session's own turn config sets that no other run does.
 *
 * Two fields used to be patched onto the config after `buildTurnConfig` returned it, in
 * `session-turn.ts`; they are now part of building it. Nothing else noticed either of them going
 * missing: the request still went out, just without its date block, and the context inspector
 * silently fell back to a preview.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS, type Settings } from "../src/config/settings.ts";
import { AgentSession } from "../src/runtime/session.ts";
import { SessionStore } from "../src/session/store.ts";
import type { LlmContext, Message, ModelConfig, ProviderConfig } from "../src/types.ts";
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

/** The date block as `prompt/environment.ts` renders it: a synthetic user message opening with `<env>`. */
const isEnvironmentMessage = (message: Message): boolean =>
	message.role === "user" && message.synthetic === true && message.content.length === 1 &&
	message.content[0].type === "text" && message.content[0].text.startsWith("<env>");

const SETTINGS: Settings = {
	...DEFAULT_SETTINGS,
	providers: [PROVIDER],
	defaultModelId: MODEL.id,
	mcpServers: [],
	permissionMode: "full",
};

test("the main session's request carries the date block and is kept for the context inspector", async () => {
	const root = await mkdtemp(join(tmpdir(), "main-request-"));
	const sent: LlmContext[] = [];
	const session = new AgentSession({
		cwd: root,
		settings: SETTINGS,
		store: new SessionStore(join(root, "sessions")),
		emit: () => {},
		streamFn: async (context) => {
			sent.push(context);
			return {
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				api: "openai-responses",
				provider: "fake",
				model: "model",
				usage: emptyUsage(),
				stopReason: "stop",
				timestamp: Date.now(),
			};
		},
	});
	try {
		await session.initialize();
		await session.prompt([{ type: "text", text: "hello" }]);

		assert.equal(sent.length, 1);
		// `session.environment`: rendered into the request, never stored in the log.
		assert.ok(sent[0].messages.some(isEnvironmentMessage), "the request has an <env> block");
		assert.ok(!session.log.messages.some(isEnvironmentMessage), "the log does not");
		// `model.onContext`: the request as sent is what the inspector reads.
		assert.equal(session.log.requestContext?.context.systemPrompt, sent[0].systemPrompt);
		assert.equal(session.log.requestContext?.model.id, MODEL.id);
	} finally {
		await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
	}
});
