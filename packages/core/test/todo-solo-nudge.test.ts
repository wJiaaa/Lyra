/**
 * 一轮里只有 todo_write 的回复，会在那条工具结果里被提醒（06 §6.3）。
 *
 * 量过：一个三步任务里，将近一半有工具调用的轮次只有一次 todo_write——每做一步就单独更新一次
 * 清单，每次多一个来回。劝告写在工具描述里不够，模型读完就忘；写在它刚做的那件事的结果里，
 * 是它下一秒要读的东西。带着真正的工作一起调的那一轮，什么都不说。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { runAgent, SOLO_TODO_NOTE } from "../src/agent/loop.ts";
import { runConfig } from "./run-config.ts";
import { readTool } from "../src/tools/read.ts";
import { todoTool } from "../src/tools/todo.ts";
import type { AssistantMessage, Message, ModelConfig, ProviderConfig, Tool } from "../src/types.ts";
import { emptyUsage } from "../src/types.ts";

let cwd: string;
before(async () => {
	cwd = await mkdtemp(join(tmpdir(), "ly-solo-todo-"));
	await writeFile(join(cwd, "a.ts"), "export const a = 1;\n", "utf8");
});
after(async () => {
	await rm(cwd, { recursive: true, force: true });
});

const MODEL: ModelConfig = { id: "fake/model", providerId: "fake", modelId: "model", name: "Fake", contextWindow: 100_000, maxOutputTokens: 4096, supportsThinking: false, supportsImages: false, supportsTools: true };
const PROVIDER: ProviderConfig = { id: "fake", name: "Fake", baseUrl: "http://l", api: "openai-responses", apiKey: "x", enabled: true, models: [MODEL] };

function reply(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return { role: "assistant", api: "openai-responses", provider: "fake", model: "model", usage: emptyUsage(), stopReason, timestamp: Date.now(), content };
}
const todoCall = (id: string) => ({ type: "toolCall" as const, id, name: "todo_write", arguments: { todos: [{ content: "读 a.ts", status: "in_progress", activeForm: "读 a.ts" }] }, argumentsText: "{}" });
const readCall = (id: string) => ({ type: "toolCall" as const, id, name: "read", arguments: { path: "a.ts" }, argumentsText: "{}" });

async function run(script: AssistantMessage[], committed: string[] = []): Promise<Message[]> {
	let at = 0;
	const result = await runAgent(
		runConfig({
			session: {
				sessionId: "solo-todo",
				systemPrompt: "x",
				messages: [{ role: "user", content: [{ type: "text", text: "读 a.ts" }], timestamp: Date.now() }],
				state: new Map(),
			},
			model: { provider: PROVIDER, model: MODEL, temperature: 0, streamFn: async () => script[Math.min(at++, script.length - 1)] },
			tools: { available: [todoTool, readTool] as unknown as Tool[], env: { cwd } },
			control: { maxTurns: 6 },
		}),
		// `message_end` 是落盘点：这里记下的就是日志里、重启后重建出来的那一份。
		async (event) => {
			if (event.type === "message_end" && event.message.role === "toolResult" && event.message.toolName === "todo_write") {
				committed.push(JSON.stringify(event.message.content));
			}
		},
	);
	return result.messages;
}

function todoResults(messages: Message[]): string[] {
	return messages
		.filter((m) => m.role === "toolResult" && m.toolName === "todo_write")
		.map((m) => m.content.map((c) => (c.type === "text" ? c.text : "")).join("\n"));
}

test("a lone todo_write gets the note in its own result; one batched with real work does not", async () => {
	const messages = await run([
		reply([todoCall("t1")], "toolUse"),
		reply([todoCall("t2"), readCall("r1")], "toolUse"),
		reply([{ type: "text", text: "读完了。" }], "stop"),
	]);
	const results = todoResults(messages);
	assert.equal(results.length, 2);
	assert.ok(results[0].includes(SOLO_TODO_NOTE), "the lone call is told, in the place the model reads next");
	assert.ok(!results[1].includes(SOLO_TODO_NOTE), "the batched call is what was asked for; nothing to say");
});

test("the note is in the result before it is committed, so a restart rebuilds what was sent", async () => {
	const committed: string[] = [];
	const messages = await run([reply([todoCall("t1")], "toolUse"), reply([{ type: "text", text: "好。" }], "stop")], committed);
	const sent = messages.find((m) => m.role === "toolResult" && m.toolName === "todo_write");
	assert.equal(committed.length, 1);
	assert.ok(committed[0].includes("往返"), "the log carries the note");
	assert.equal(committed[0], JSON.stringify(sent?.content), "and nothing is changed after the commit");
});

test("the note names the cost, and the tool's own guidance already says never to do this", () => {
	assert.match(SOLO_TODO_NOTE, /往返/);
	assert.match(todoTool.description, /only tool call/i, "the rule is in the description too — the note is for the model that skimmed it");
});
