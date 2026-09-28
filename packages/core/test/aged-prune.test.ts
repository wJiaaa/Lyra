import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionPruner, AgedToolPruner } from "../src/runtime/aged-prune.ts";
import { emptyUsage, type Message } from "../src/types.ts";

const output = (size = 20_000): Message => ({ role: "toolResult", toolName: "bash", toolCallId: "c", isError: false, content: [{ type: "text", text: "😀".repeat(size) }], timestamp: 0 });
const rounds = (n: number, size = 1): Message[] => Array.from({ length: n }, () => ({ role: "assistant", api: "openai-responses", provider: "test", model: "test", stopReason: "stop", usage: emptyUsage(), content: [{ type: "text", text: "x".repeat(size) }], timestamp: 0 }));

test("what went out whole is sent whole again, however many rounds later", () => {
	const history = [output(), ...rounds(1)];
	const pruner = new AgedToolPruner();
	assert.equal(pruner.prepare(history), history);
	const later = [...history, ...rounds(100, 2000)];
	for (let i = 0; i < 25; i++) assert.equal(pruner.prepare(later), later, "no aging, no batch: the prefix is never rewritten");
});

test("a blow-up is cut before its first send, with the log intact and the original kept", () => {
	const huge = output(80_000);
	const history = [huge, ...rounds(2)];
	const saved: string[] = [];
	const pruner = new AgedToolPruner();
	const next = pruner.prepare(history, { keep: (_tool, text) => { saved.push(text); return "artifact://x"; } });
	assert.notEqual(next, history);
	assert.equal(next.length, history.length);
	assert.equal(next[0].role === "toolResult" && next[0].toolCallId, "c");
	assert.match(JSON.stringify(next[0]), /characters omitted/);
	assert.match(JSON.stringify(next[0]), /artifact:\/\/x/);
	assert.equal(saved.length, 1);
	assert.equal(huge.content[0].type === "text" && huge.content[0].text.length, 160_000);
	assert.equal(pruner.prepare(history)[0], next[0], "continuations reuse the same view");
});

test("a rebuilt pruner — as after a restart — derives the same view from the log", () => {
	const keep = (_tool: string, text: string) => `artifact://${text.length}`;
	const empty: Message = { ...output(300), toolCallId: "e", uneventful: true } as Message;
	const history = [output(80_000), empty, ...rounds(3)];
	const before = new AgedToolPruner().prepare(history, { keep });
	const after = new AgedToolPruner().prepare(history, { keep });
	assert.deepEqual(after, before);
	assert.match(JSON.stringify(before[1]), /无结果/, "uneventful output is emptied before its first send");
});

test("small results and skill instructions stay intact", () => {
	const skill = output(80_000);
	if (skill.role === "toolResult") skill.toolName = "skill";
	const history = [output(4096), skill, ...rounds(30)];
	assert.equal(new AgedToolPruner().prepare(history), history);
});

test("a session keeps its pruning view across user turns and other sessions remain isolated", () => {
	const state = new Map<string, unknown>();
	assert.equal(sessionPruner(state), sessionPruner(state));
	assert.notEqual(sessionPruner(state), sessionPruner(new Map()));
});

test("the live request path actually sends the cut view while keeping its source intact", async () => {
	const { runAgent } = await import("../src/agent/loop.ts");
	const source = output(80_000);
	const history = [source, ...rounds(1)];
	const model = { id: "m", modelId: "m", providerId: "p", name: "m", contextWindow: 1_000_000, maxOutputTokens: 100, supportsThinking: false, supportsImages: false, supportsTools: true };
	let sent: Message[] = [];
	await runAgent({ sessionId: "t", cwd: "/test", model, provider: { id: "p", name: "p", api: "openai-responses", baseUrl: "http://localhost", apiKey: "", enabled: true, models: [model] }, messages: history, tools: [], systemPrompt: "", streamFn: async context => {
		sent = context.messages;
		const answer = rounds(1)[0];
		if (answer.role !== "assistant") throw new Error("Invalid fixture");
		return answer;
	} }, async () => {});
	assert.notEqual(sent[0], source);
	assert.match(JSON.stringify(sent[0].content), /characters omitted/);
	assert.equal(source.content[0].type === "text" && source.content[0].text.length, 160_000);
});
