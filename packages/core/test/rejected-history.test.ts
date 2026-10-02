/**
 * A conversation the provider will not accept, and the way out of it.
 *
 * A 4xx is not retried, and that is right: the same request gets the same answer. But when the
 * request *is* the history, nothing changes on its own — every later attempt carries the same
 * rejected payload, so retry fails, continue fails, and opening the conversation tomorrow fails.
 * It is not a failing turn, it is a sealed conversation.
 *
 * This was reported against a relay translating Responses into Gemini: a 60,000-character `gh api`
 * dump in one tool result produced `Unknown name "safetySettings" at 'request.contents[42]'` on
 * every attempt. Verified against that relay with the user's own stuck session: as posted it is a
 * 400, with the oversized results dropped to a line each it is a 200 — and an equally long *plain
 * text* result was accepted, which is how we know the size was never the problem.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { runAgent } from "../src/agent/loop.ts";
import { runConfig } from "./run-config.ts";
import { PRUNE_THRESHOLD_CHARS, stripOversizedToolResults } from "../src/agent/prune.ts";
import type { AgentEvent } from "../src/agent/events.ts";
import type { AssistantMessage, Message, ModelConfig, ProviderConfig } from "../src/types.ts";
import { emptyUsage } from "../src/types.ts";
import { classifyFailure } from "../src/ai/failure.ts";

const MODEL: ModelConfig = {
	id: "fake/model",
	providerId: "fake",
	modelId: "model",
	name: "Fake",
	contextWindow: 200_000,
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

const huge = "x".repeat(PRUNE_THRESHOLD_CHARS * 3);

function history(): Message[] {
	return [
		{ role: "user", content: [{ type: "text", text: "看看发布列表" }], timestamp: 1 },
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {}, argumentsText: "{}" }],
			api: "openai-responses",
			provider: "fake",
			model: "model",
			usage: emptyUsage(),
			stopReason: "toolUse",
			timestamp: 2,
		},
		{ role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: huge }], isError: false, timestamp: 3 },
	];
}

function reply(over: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "好" }],
		api: "openai-responses",
		provider: "fake",
		model: "model",
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: 9,
		...over,
	};
}

// 失败按生产路径分类，和三条协议链出错时带上的 `failure` 一样。
const rejected = (status: number) =>
	reply({
		content: [],
		stopReason: "error",
		errorMessage: `HTTP ${status}: {"error":{"code":${status}}}`,
		errorRetryable: false,
		failure: classifyFailure({ from: "status", status, body: `{"error":{"code":${status}}}` }),
	});

/** Runs the loop with a scripted provider, and reports what each request carried. */
async function run(replies: AssistantMessage[]) {
	const sent: Message[][] = [];
	const notices: string[] = [];
	let at = 0;
	const result = await runAgent(
		runConfig({
			session: { messages: history() },
			model: {
				provider: PROVIDER,
				model: MODEL,
				streamFn: async (context) => {
					sent.push(context.messages.map((m) => m));
					return replies[Math.min(at++, replies.length - 1)];
				},
			},
		}),
		async (event: AgentEvent) => {
			if (event.type === "notice") notices.push(event.message);
		},
	);
	return { sent, notices, result };
}

/** The size of the largest tool result in a history, which is what recovery acts on. */
const biggest = (messages: Message[]) =>
	Math.max(
		0,
		...messages
			.filter((m) => m.role === "toolResult")
			.map((m) => m.content.reduce((sum, c) => sum + (c.type === "text" ? c.text.length : 0), 0)),
	);

test("a rejected request is retried once without the oversized result", async () => {
	const { sent, notices, result } = await run([rejected(400), reply({})]);

	assert.equal(sent.length, 2, "one retry, not more");
	assert.ok(biggest(sent[0]) > PRUNE_THRESHOLD_CHARS, "the first attempt carried it in full");
	assert.ok(biggest(sent[1]) < 400, "the second attempt did not");
	assert.equal(result.reason, "done", "and the turn carried on");
	assert.ok(
		notices.some((message) => message.includes("过大的工具输出")),
		"the user is told what was dropped and why",
	);
});

test("what replaces it says where the real output went", () => {
	const stripped = stripOversizedToolResults(history());
	const text = (stripped[2] as { content: { type: string; text: string }[] }).content[0].text;
	assert.match(text, /characters of output withheld/);
	assert.match(text, /kept in the session|in the session/);
});

test("413 and 422 are the same kind of refusal", async () => {
	for (const status of [413, 422]) {
		const { sent } = await run([rejected(status), reply({})]);
		assert.equal(sent.length, 2, `HTTP ${status} should be recovered from`);
	}
});

test("a key or a queue is not something a smaller history fixes", async () => {
	for (const status of [401, 403, 404, 429, 500]) {
		const { sent, result } = await run([rejected(status), reply({})]);
		assert.equal(sent.length, 1, `HTTP ${status} must not spend a second request`);
		assert.equal(result.reason, "error");
	}
});

test("a dropped socket is left to the retry that already handles it", async () => {
	const dropped = reply({
		content: [],
		stopReason: "error",
		errorMessage: "fetch failed (UND_ERR_SOCKET)",
		errorRetryable: true,
	});
	const { sent } = await run([dropped, reply({})]);
	assert.equal(sent.length, 1);
});

test("with nothing oversized to drop, the refusal is reported as it is", async () => {
	const small: Message[] = [{ role: "user", content: [{ type: "text", text: "你好" }], timestamp: 1 }];
	const sent: Message[][] = [];
	const result = await runAgent(
		runConfig({
			session: { messages: small },
			model: {
				provider: PROVIDER,
				model: MODEL,
				streamFn: async (context) => {
					sent.push(context.messages);
					return rejected(400);
				},
			},
		}),
		async () => {},
	);
	assert.equal(sent.length, 1, "nothing to drop means nothing to retry");
	assert.equal(result.reason, "error");
});

test("recovery happens once per turn, not in a loop", async () => {
	// Still refused after the history was cut: report it rather than trying forever.
	const { sent, result } = await run([rejected(400), rejected(400)]);
	assert.equal(sent.length, 2);
	assert.equal(result.reason, "error");
});
