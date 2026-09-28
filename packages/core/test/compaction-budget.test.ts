/**
 * Two budgets compaction has to actually keep: what the summary request may weigh, and how much a
 * prune has to save before the summary is skipped.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { compactIfNeeded } from "../src/runtime/compaction.ts";
import { estimateTokens } from "../src/tokens.ts";
import { emptyUsage, type AssistantMessage, type LlmContext, type Message, type ModelConfig, type ProviderConfig } from "../src/types.ts";

const model = (contextWindow: number, id = "fake/model"): ModelConfig => ({ id, providerId: "fake", modelId: id, name: "Fake", contextWindow, maxOutputTokens: 1000, supportsThinking: false, supportsImages: false, supportsTools: true });
const provider = (m: ModelConfig): ProviderConfig => ({ id: "fake", name: "Fake", baseUrl: "http://localhost", api: "anthropic-messages", apiKey: "x", enabled: true, models: [m] });
const user = (...texts: string[]): Message => ({ role: "user", content: texts.map((text) => ({ type: "text" as const, text })), timestamp: 1 });
const reply = (content: AssistantMessage["content"], input = 0): AssistantMessage => ({ role: "assistant", content, api: "anthropic-messages", provider: "fake", model: "model", usage: { ...emptyUsage(), input }, stopReason: "stop", timestamp: 1 });
const say = (text: string, input = 0) => reply([{ type: "text", text }], input);
const toolResult = (id: string, text: string): Message => ({ role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text }], isError: false, timestamp: 1 });

/** Records every summary request; `summary` is what the fake model answers. */
function recorder(summary = "摘要") {
	const requests: LlmContext[] = [];
	const stream = async function* (_p: unknown, _m: unknown, context: LlmContext) {
		requests.push(context);
		yield { type: "start" as const, partial: say("") };
		return say(summary);
	};
	return { requests, stream: stream as never };
}

/** Everything the summary request carries, in the estimate's units. */
const requestTokens = (context: LlmContext) => Math.ceil(context.systemPrompt.length / 3.5) + estimateTokens(context.messages);
/** The condensed history alone: the last message is the instruction. */
const historyTokens = (context: LlmContext) => estimateTokens(context.messages.slice(0, -1));

test("a history of many-block messages is condensed to the budget as a whole, not per block", async () => {
	const m = model(10_000);
	const history: Message[] = [user("做这件事")];
	for (let i = 0; i < 16; i++) {
		history.push(user(...Array.from({ length: 10 }, (_, b) => `块${i}.${b} ${"u".repeat(2000)}`)));
		history.push(reply([
			{ type: "thinking", thinking: "t".repeat(6000) },
			{ type: "text", text: `做了第 ${i} 步 ${"r".repeat(3000)}` },
			{ type: "toolCall", id: `c${i}`, name: "write", arguments: { path: `/repo/f${i}.ts`, content: "w".repeat(4000), note: "n".repeat(4000) } },
		]));
		history.push(toolResult(`c${i}`, `ok ${i}`));
	}
	const { requests, stream } = recorder();
	const result = await compactIfNeeded(history, m, provider(m), stream);
	assert.ok(result?.kept !== undefined, "precondition: it summarised");
	const sent = historyTokens(requests[0]);
	assert.ok(sent <= m.contextWindow * 0.4, `the condensed history keeps its budget: ${sent}`);
	const calls = requests[0].messages.flatMap((message) => (message.role === "assistant" ? message.content : [])).filter((part) => part.type === "toolCall");
	// The summary covers everything before the kept tail, which at least holds the last exchange.
	assert.equal(calls.length, 15, "every summarised step is still there");
	assert.ok(!requests[0].messages.some((message) => message.content.some((block) => block.type === "text" && block.text.includes("omitted here"))), "none was dropped");
	for (const call of calls) assert.match(JSON.stringify(call.type === "toolCall" && call.arguments), /\/repo\/f\d+\.ts/, "with the path it touched");
});

test("more messages than a per-message floor can fit drop the oldest middle, and say so", async () => {
	const m = model(10_000);
	const history: Message[] = [user(`目标：把整个仓库迁移过去 ${"g".repeat(200)}`)];
	for (let i = 0; i < 200; i++) {
		history.push(say(`第 ${i} 步 ${"s".repeat(300)}`));
		history.push(user(`继续 ${i} ${"c".repeat(300)}`));
	}
	const { requests, stream } = recorder();
	const result = await compactIfNeeded(history, m, provider(m), stream);
	assert.ok(result?.kept !== undefined, "precondition: it summarised");
	const sent = requests[0].messages;
	assert.ok(historyTokens(requests[0]) <= m.contextWindow * 0.4, `the budget holds however many messages there are: ${historyTokens(requests[0])}`);
	const text = (message: Message) => message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
	assert.match(text(sent[0]), /^目标：把整个仓库迁移过去/, "the opening request is kept");
	assert.ok(sent.some((message) => /omitted/.test(text(message))), "the gap is marked");
	const older = history.length - result.kept!;
	assert.ok(sent.some((message) => text(message).startsWith(text(history[older - 1]).slice(0, 12))), "the newest summarised step is kept");
});

test("the summary request is checked against the summariser's window before it is sent", async () => {
	const m = model(10_000);
	const small = model(2_000, "fake/small");
	const history: Message[] = [user("开始")];
	for (let i = 0; i < 30; i++) history.push(say(`步骤 ${i} ${"x".repeat(1500)}`), user(`继续 ${"y".repeat(1500)}`));
	const { requests, stream } = recorder();
	await compactIfNeeded(history, m, provider(m), stream, 0, false, undefined, undefined, { model: small, provider: provider(small) });
	assert.equal(requests.length, 1, "precondition: a summary was asked for");
	const total = requestTokens(requests[0]);
	assert.ok(total + small.contextWindow / 4 <= small.contextWindow, `the request leaves the summary room to be written: ${total}`);
});

test("a request that cannot fit is not sent", async () => {
	const m = model(10_000);
	const history: Message[] = [user("开始")];
	for (let i = 0; i < 30; i++) history.push(say(`步骤 ${i} ${"x".repeat(1500)}`), user(`继续 ${"y".repeat(1500)}`));
	const { requests, stream } = recorder();
	await assert.rejects(
		compactIfNeeded(history, m, provider(m), stream, 0, true, undefined, { instructions: "重点".repeat(20_000) }),
		"a manual compaction says why instead of sending a request the model must refuse",
	);
	assert.equal(requests.length, 0);
});

test("cutting results the last request sent whole skips the summary once the measured size says it fits", async () => {
	/*
	 * The loop hands compaction the view it sent last time. Results younger than the aged-prune batch
	 * went out whole, so cutting them here is a real saving — and the measured usage, which counted
	 * them whole, has to be scaled onto the cut copy rather than taken as its size.
	 */
	const m = model(10_000);
	const history: Message[] = [user("找一下")];
	for (let i = 0; i < 3; i++) history.push(reply([{ type: "toolCall", id: `g${i}`, name: "grep", arguments: { pattern: `p${i}` } }]), toolResult(`g${i}`, `${i}`.repeat(12_000)));
	history.push(say("完成", estimateTokens(history)));
	const { requests, stream } = recorder();
	const result = await compactIfNeeded(history, m, provider(m), stream);
	assert.ok(result, "it compacted");
	assert.equal(requests.length, 0, "without asking for a summary");
	assert.equal(result.messages.length, history.length, "only cut");
	assert.ok(estimateTokens(result.messages) < m.contextWindow * 0.7);
});

test("a measured history the cut cannot bring under the margin is still summarised", async () => {
	// Twice what the estimate says, as CJK and dense JSON run: the same cut saves too little.
	const m = model(10_000);
	const history: Message[] = [user("找一下")];
	for (let i = 0; i < 3; i++) history.push(reply([{ type: "toolCall", id: `g${i}`, name: "grep", arguments: { pattern: `p${i}` } }]), toolResult(`g${i}`, `${i}`.repeat(12_000)));
	for (let i = 0; i < 6; i++) history.push(say(`说明 ${"z".repeat(1200)}`), user(`继续 ${"q".repeat(1200)}`));
	history.push(say("完成", estimateTokens(history) * 2));
	const { requests, stream } = recorder();
	const result = await compactIfNeeded(history, m, provider(m), stream);
	assert.ok(result?.kept !== undefined, "it summarised");
	assert.equal(requests.length, 1);
});

test("the reply the summary request asks for is the room the pre-send check kept for it", async () => {
	// Measured at twice the estimate: the check prices the history calibrated, so the reply it lets
	// through has to be the one it reserved, not one sized again from the uncalibrated estimate.
	const m: ModelConfig = { ...model(10_000), maxOutputTokens: 8000 };
	const history: Message[] = [user("开始")];
	for (let i = 0; i < 12; i++) history.push(say(`步骤 ${i} ${"x".repeat(1200)}`), user(`继续 ${"y".repeat(1200)}`));
	history.push(say("完成", estimateTokens(history) * 2));
	const sent: { context: LlmContext; maxTokens?: number }[] = [];
	const stream = async function* (_p: unknown, _m: unknown, context: LlmContext, options: { maxTokens?: number }) {
		sent.push({ context, maxTokens: options.maxTokens });
		yield { type: "start" as const, partial: say("") };
		return say("摘要");
	};
	await compactIfNeeded(history, m, provider(m), stream as never);
	assert.equal(sent.length, 1, "precondition: a summary was asked for");
	const input = requestTokens(sent[0].context) * 2;
	assert.ok(input + (sent[0].maxTokens ?? m.maxOutputTokens) <= m.contextWindow, `calibrated input ${input} + reply ${sent[0].maxTokens} fits the window`);
});
