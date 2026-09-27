import assert from "node:assert/strict";
import { test } from "node:test";
import { toAnthropicMessages } from "../src/ai/anthropic-messages-request.ts";
import { compactIfNeeded } from "../src/runtime/compaction.ts";
import { estimateTokens } from "../src/tokens.ts";
import { emptyUsage, type AssistantMessage, type Message, type ModelConfig, type ProviderConfig } from "../src/types.ts";

const model = (contextWindow: number): ModelConfig => ({ id: "fake/model", providerId: "fake", modelId: "model", name: "Fake", contextWindow, maxOutputTokens: 1000, supportsThinking: false, supportsImages: false, supportsTools: true });
const provider = (m: ModelConfig): ProviderConfig => ({ id: "fake", name: "Fake", baseUrl: "http://localhost", api: "anthropic-messages", apiKey: "x", enabled: true, models: [m] });
const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const reply = (content: AssistantMessage["content"], input = 0): AssistantMessage => ({ role: "assistant", content, api: "anthropic-messages", provider: "fake", model: "model", usage: { ...emptyUsage(), input }, stopReason: "stop", timestamp: 1 });

function spy(onContext: (messages: Message[]) => void) {
	return async function* (_p: unknown, _m: unknown, context: { messages: Message[] }) {
		onContext(context.messages);
		yield { type: "start" as const, partial: reply([]) };
		return reply([{ type: "text", text: "摘要" }]);
	};
}

test("condensed tool calls keep their clipped arguments for protocols that read the object", async () => {
	const m = model(10_000);
	const command = `npm test -- ${"--flag ".repeat(2000)}`;
	const messages: Message[] = [
		user("fix it"),
		reply([{ type: "toolCall", id: "t1", name: "bash", arguments: { path: "/repo/src/app.ts", command }, argumentsText: JSON.stringify({ path: "/repo/src/app.ts", command }) }]),
		{ role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 1 },
		...Array.from({ length: 30 }, (_, i) => (i % 2 ? user(`next ${"y".repeat(2000)}`) : reply([{ type: "text", text: `step ${"x".repeat(2000)}` }]))),
	];
	let sent: Message[] = [];
	const result = await compactIfNeeded(messages, m, provider(m), spy((next) => { sent = next; }) as never);
	assert.ok(result?.kept !== undefined, "precondition: it summarised");
	const call = sent.flatMap((message) => (message.role === "assistant" ? message.content : [])).find((part) => part.type === "toolCall");
	assert.ok(call && call.type === "toolCall");
	assert.ok(call.argumentsText!.length < command.length, "precondition: the arguments were clipped");
	assert.deepEqual(JSON.parse(call.argumentsText!), call.arguments, "both copies say the same thing");
	const wire = toAnthropicMessages(sent).flatMap((message) => (Array.isArray(message.content) ? message.content : []));
	const use = wire.find((block) => (block as { type: string }).type === "tool_use") as { input: { path?: string; command?: string } } | undefined;
	assert.equal(use?.input.path, "/repo/src/app.ts");
	assert.match(use?.input.command ?? "", /^npm test -- --flag/);
});

test("the summary request budget is corrected by the measured token ratio", async () => {
	const m = model(200_000);
	const history: Message[] = [];
	for (let i = 0; i < 60; i++) {
		history.push(user(`需求${i}${"中文说明".repeat(750)}`));
		history.push(reply([{ type: "text", text: `回复${i}${"处理结果".repeat(750)}` }]));
	}
	// The provider counted far more than characters over 3.5 suggest, as it does on CJK.
	history[history.length - 1] = reply([{ type: "text", text: "最后" }], 190_000);
	const scale = 190_000 / estimateTokens(history);
	assert.ok(scale > 1.5, `precondition: the estimate runs low (${scale})`);
	let sent: Message[] = [];
	const result = await compactIfNeeded(history, m, provider(m), spy((next) => { sent = next; }) as never);
	assert.ok(result?.kept !== undefined, "precondition: it summarised");
	const weight = estimateTokens(sent) * scale;
	assert.ok(weight <= m.contextWindow * 0.42, `summary input must fit its budget once corrected: ${Math.round(weight)}`);
});
