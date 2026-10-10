/**
 * 正文收尾时清单还挂着没勾的项，循环问它一次（见 `openPlanNote`）。
 *
 * 起因是 2026-10-10 的 `2333f4e9`：五步全做完，最后一条回复的思考里写着要勾清单，回复里却没有这次
 * 调用，清单停在 1/5。这里守的是：只问一次；只动清单就到此为止，不再要一段新正文；清单勾完了、
 * 没写、或者剩下的只是等着的 pending，就什么都不说。还有工作途中那一句：清单十轮没碰过就念给它听。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { openPlanNote, runAgent, SOLO_TODO_NOTE, stalePlanNote, type AgentRunResult } from "../src/agent/loop.ts";
import { runConfig } from "./run-config.ts";
import { readTool } from "../src/tools/read.ts";
import { todoTool, type TodoItem } from "../src/tools/todo.ts";
import type { AssistantMessage, Message, ModelConfig, ProviderConfig, Tool } from "../src/types.ts";
import { emptyUsage } from "../src/types.ts";

let cwd: string;
before(async () => {
	cwd = await mkdtemp(join(tmpdir(), "ly-open-plan-"));
	await writeFile(join(cwd, "a.ts"), "export const a = 1;\n", "utf8");
	// 每轮读一个不同的文件：连读同一个会被重复检测叫停，那量的就不是这里要量的事了。
	for (let i = 0; i < 20; i++) await writeFile(join(cwd, `f${i}.ts`), `export const f${i} = ${i};\n`, "utf8");
});
after(async () => {
	await rm(cwd, { recursive: true, force: true });
});

const MODEL: ModelConfig = { id: "fake/model", providerId: "fake", modelId: "model", name: "Fake", contextWindow: 100_000, maxOutputTokens: 4096, supportsThinking: false, supportsImages: false, supportsTools: true };
const PROVIDER: ProviderConfig = { id: "fake", name: "Fake", baseUrl: "http://l", api: "openai-responses", apiKey: "x", enabled: true, models: [MODEL] };

function reply(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return { role: "assistant", api: "openai-responses", provider: "fake", model: "model", usage: emptyUsage(), stopReason, timestamp: Date.now(), content };
}
const OPEN: TodoItem[] = [
	{ content: "读 a.ts", status: "completed" },
	{ content: "总结", status: "in_progress", activeForm: "总结中" },
];
const DONE: TodoItem[] = OPEN.map((todo) => ({ ...todo, status: "completed" }));
const todoCall = (id: string, todos: TodoItem[]) => ({ type: "toolCall" as const, id, name: "todo_write", arguments: { todos }, argumentsText: "{}" });
const readCall = (id: string) => ({ type: "toolCall" as const, id, name: "read", arguments: { path: "a.ts" }, argumentsText: "{}" });
const text = (value: string) => ({ type: "text" as const, text: value });

/** Runs the script; a request past its end fails the test instead of replaying the last reply. */
async function run(script: AssistantMessage[], maxTurns = 8): Promise<{ result: AgentRunResult; requests: number }> {
	let requests = 0;
	const result = await runAgent(
		runConfig({
			session: {
				sessionId: "open-plan",
				systemPrompt: "x",
				messages: [{ role: "user", content: [text("读 a.ts 然后总结")], timestamp: Date.now() }],
				state: new Map(),
			},
			model: {
				provider: PROVIDER,
				model: MODEL,
				temperature: 0,
				streamFn: async () => {
					const next = script[requests++];
					assert.ok(next, `request ${requests} was not expected`);
					return next;
				},
			},
			tools: { available: [todoTool, readTool] as unknown as Tool[], env: { cwd } },
			control: { maxTurns },
		}),
		async () => {},
	);
	return { result, requests };
}

const notes = (messages: Message[]) =>
	messages.filter((m) => m.role === "user" && m.synthetic && m.content.some((c) => c.type === "text" && c.text.startsWith("（自动提示）任务清单")));

test("an answer left with open items is asked once; ticking the list ends the run without another reply", async () => {
	const { result, requests } = await run([
		reply([todoCall("t1", OPEN), readCall("r1")], "toolUse"),
		reply([text("a 导出了常量 1。")], "stop"),
		reply([todoCall("t2", DONE)], "toolUse"),
	]);
	assert.equal(requests, 3, "nothing is asked after the list is ticked");
	assert.equal(result.reason, "done");
	const asked = notes(result.messages);
	assert.equal(asked.length, 1);
	assert.deepEqual(asked[0].content, [text(openPlanNote([OPEN[1]]))], "only the open item is listed");
	const last = result.messages.at(-1);
	assert.equal(last?.role, "toolResult");
	const said = last?.role === "toolResult" ? last.content.map((c) => (c.type === "text" ? c.text : "")).join("") : "";
	assert.ok(!said.includes(SOLO_TODO_NOTE), "answering the question with the list alone is what was asked");
});

test("asked once only: answering with prose again ends the run", async () => {
	const { result, requests } = await run([
		reply([todoCall("t1", OPEN), readCall("r1")], "toolUse"),
		reply([text("a 导出了常量 1。")], "stop"),
		reply([text("等你确认后再总结。")], "stop"),
	]);
	assert.equal(requests, 3);
	assert.equal(result.reason, "done");
	assert.equal(notes(result.messages).length, 1);
});

test("work picked up after the question carries on as a normal run", async () => {
	const { result, requests } = await run([
		reply([todoCall("t1", OPEN), readCall("r1")], "toolUse"),
		reply([text("先到这里。")], "stop"),
		reply([todoCall("t2", DONE), readCall("r2")], "toolUse"),
		reply([text("总结：a 导出了常量 1。")], "stop"),
	]);
	assert.equal(requests, 4, "real work alongside the list is not cut off");
	assert.equal(result.reason, "done");
	assert.equal(notes(result.messages).length, 1);
});

test("a finished list, or none at all, ends on the answer", async () => {
	for (const script of [
		[reply([todoCall("t1", DONE), readCall("r1")], "toolUse"), reply([text("a 导出了常量 1。")], "stop")],
		[reply([readCall("r1")], "toolUse"), reply([text("a 导出了常量 1。")], "stop")],
	]) {
		const { result, requests } = await run(script);
		assert.equal(requests, 2);
		assert.equal(notes(result.messages).length, 0);
	}
});

test("only pending items left means it stopped on purpose — nothing is asked", async () => {
	const waiting: TodoItem[] = [{ content: "读 a.ts", status: "completed" }, { content: "等确认后总结", status: "pending" }];
	const { result, requests } = await run([
		reply([todoCall("t1", waiting), readCall("r1")], "toolUse"),
		reply([text("a 读完了，确认后我再总结。")], "stop"),
	]);
	assert.equal(requests, 2);
	assert.equal(notes(result.messages).length, 0);
});

const readFile = (id: string, n: number) => ({ type: "toolCall" as const, id, name: "read", arguments: { path: `f${n}.ts` }, argumentsText: "{}" });
const reads = (n: number, from = 0) => Array.from({ length: n }, (_, i) => reply([readFile(`r${from + i}`, from + i)], "toolUse"));

test("ten rounds without touching the list: the list is read back once, between rounds", async () => {
	const { result, requests } = await run([
		reply([todoCall("t1", OPEN), readCall("r0")], "toolUse"),
		...reads(9, 1),
		reply([readFile("ra", 17), readFile("rb", 18)], "toolUse"),
		reply([todoCall("t2", DONE), readCall("rc")], "toolUse"),
		reply([text("总结：a 导出了常量 1。")], "stop"),
	], 16);
	assert.equal(requests, 13, "the reminder goes out with the next request; it costs none of its own");
	const said = result.messages.flatMap((m, index) => (m.role === "user" && m.synthetic && m.content.some((c) => c.type === "text" && c.text === stalePlanNote(OPEN)) ? [index] : []));
	assert.equal(said.length, 1, "said once in ten rounds");
	const before = result.messages[said[0] - 1];
	assert.equal(before.role === "toolResult" ? before.toolCallId : "", "rb", "after the tenth round's results, before the next reply");
});

test("writing the list restarts the count", async () => {
	const { result } = await run([
		reply([todoCall("t1", OPEN), readCall("r0")], "toolUse"),
		...reads(6, 1),
		reply([todoCall("t2", OPEN), readCall("r7")], "toolUse"),
		...reads(6, 8),
		reply([todoCall("t3", DONE), readCall("r14")], "toolUse"),
		reply([text("总结：a 导出了常量 1。")], "stop"),
	], 20);
	assert.equal(result.messages.filter((m) => m.role === "user" && m.content.some((c) => c.type === "text" && c.text.startsWith("（自动提示）任务清单已经"))).length, 0);
});
