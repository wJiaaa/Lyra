/**
 * Stop means stop, whatever the tool is doing.
 *
 * A tool is given the abort signal and is expected to honour it, but a real one may not: a page
 * that never answers, a socket with no timeout, a process ignoring the signal. The turn must end
 * anyway — otherwise the button lies.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { runAgent } from "../src/agent/loop.ts";
import type { AssistantMessage, ModelConfig, ProviderConfig, Tool } from "../src/types.ts";
import { emptyUsage } from "../src/types.ts";
import { runConfig } from "./run-config.ts";

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

/** Never settles, and never looks at the signal — the worst-behaved tool there is. */
const wedged = {
	name: "wedged",
	description: "never returns",
	parameters: { type: "object", properties: {}, additionalProperties: false },
	summarize: () => "wedged call",
	execute: () => new Promise(() => {}),
} as unknown as Tool;

test("aborting ends the turn even when a tool never returns", async () => {
	const controller = new AbortController();

	const run = runAgent(
		runConfig({
			session: {
				sessionId: "s1",
				systemPrompt: "",
				messages: [{ role: "user", content: [{ type: "text", text: "go" }], timestamp: Date.now() }],
			},
			model: {
				provider: PROVIDER,
				model: MODEL,
				streamFn: async () =>
					({
						role: "assistant",
						content: [{ type: "toolCall", id: "c1", name: "wedged", arguments: {} }],
						api: "openai-responses",
						provider: "fake",
						model: "model",
						usage: emptyUsage(),
						stopReason: "toolUse",
						timestamp: Date.now(),
					}) as AssistantMessage,
			},
			tools: { available: [wedged], env: { cwd: "/tmp" } },
			control: { signal: controller.signal },
		}),
		() => {},
	);

	// The tool is in flight and will never finish; the user presses stop.
	setTimeout(() => controller.abort(), 50);

	const finished = await Promise.race([
		run.then(() => "ended"),
		new Promise((resolve) => setTimeout(() => resolve("hung"), 5000)),
	]);
	assert.equal(finished, "ended", "the turn ended rather than waiting on the tool");
	const result = (await run).messages.find(message => message.role === "toolResult");
	assert.ok(result?.role === "toolResult");
	assert.deepEqual(result.details, { cancelled: true }, "the durable result distinguishes a user stop from a tool failure");
});
