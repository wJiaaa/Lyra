/**
 * 日期跟在它所属的用户消息后面，既不在 system prompt 里，也不在请求的最末尾。
 *
 * 这条测的是**位置**，而位置就是全部的意义。放 system prompt，每天头一次请求要为整个对话重付
 * 一次全额；放最末尾，它永远是「最后一条用户消息」，DeepSeek 会丢掉它之前所有助手轮的推理，
 * 上一轮的输出也进不了缓存。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { today, withEnvironment } from "../src/prompt/environment.ts";
import { buildSystemPrompt } from "../src/prompt/system.ts";
import { runAgent } from "../src/agent/loop.ts";
import type { AssistantMessage, Message } from "../src/types.ts";
import { emptyUsage } from "../src/types.ts";
import { runConfig } from "./run-config.ts";

const DAY1 = new Date(2026, 8, 4, 10).getTime();
const DAY2 = new Date(2026, 8, 5, 10).getTime();
const user = (text: string, timestamp = DAY1): Message => ({ role: "user", content: [{ type: "text", text }], timestamp });
const assistant = (text: string): Message =>
	({ role: "assistant", content: [{ type: "text", text }], api: "openai-responses", provider: "fake", model: "model", usage: emptyUsage(), stopReason: "stop", timestamp: 1 }) as AssistantMessage;
const textOf = (message: Message | undefined) => message?.content.map((c) => (c.type === "text" ? c.text : "")).join("") ?? "";

const PROMPT_INPUT = {
	cwd: "/tmp/p",
	tools: [],
	skills: [],
	projectInstructions: [],
	platform: "darwin",
	modelName: "M",
	isGitRepo: true,
};

test("system prompt 里没有日期", async () => {
	/*
	 * 直接断言「不含今天的日期」，而不是断言某个字段不存在：字段可以改名，而这条要拦的是
	 * 「有人又把一个每天变的值写回最前面那一段」。
	 */
	const prompt = await buildSystemPrompt(PROMPT_INPUT);
	assert.ok(!prompt.includes(today()), "system prompt 必须是静态的，不能含今天的日期");
	assert.ok(!/Today's date/i.test(prompt));
});

test("日期跟在第一条用户消息后面，取那条消息自己的日期", () => {
	const messages = withEnvironment([user("你好"), assistant("好"), user("再问一句")]);

	assert.equal(messages.length, 4, "同一天只说一次");
	assert.equal(textOf(messages[0]), "你好");
	assert.match(textOf(messages[1]), /<env>[\s\S]*2026-09-04/);
	assert.equal(textOf(messages.at(-1)), "再问一句", "最后一条是人说的话，不是日期块");
});

test("标成 synthetic，因为不是人说的", () => {
	/*
	 * `clearActiveSkill`、纠正分类器、记忆抽取都按这个字段区分「谁在说话」。漏标的话，一条
	 * 日期播报会被当成用户的一次发言——纠正分类器会去分析它，技能会被它清掉。
	 */
	const messages = withEnvironment([user("你好")]);
	assert.equal(messages.at(-1)?.synthetic, true);
});

test("说明自己是环境信息，不是请求", () => {
	/*
	 * 它在结构上占的正是「用户最后说的话」那个位置。不说清楚，模型会把它当成刚收到的指令，
	 * 然后回一句关于日期的话。
	 */
	const messages = withEnvironment([user("改一下这个函数")]);
	const text = messages.at(-1)?.content[0];
	assert.match(text?.type === "text" ? text.text : "", /<env>/);
	assert.match(text?.type === "text" ? text.text : "", /不是用户的请求/);
});

test("空历史不加——没有可缓存的前缀，也没有对话", () => {
	assert.deepEqual(withEnvironment([]), []);
});

test("压缩后只剩合成消息时，接在第一条用户消息后面", () => {
	const summary: Message = { ...user("<session-summary>…</session-summary>"), synthetic: true };
	const messages = withEnvironment([summary, assistant("好")]);
	assert.match(textOf(messages[1]), /<env>/);
});

test("同一份历史每次渲染出同样的字节", () => {
	/*
	 * 缓存要的就是这个。日期只从消息自己的时间戳来，不看现在几点——否则跨天那一刻整段历史都会变。
	 */
	const history = [user("你好"), assistant("好"), user("再问一句", DAY2)];
	assert.deepEqual(withEnvironment(history), withEnvironment(history));
});

test("跨天只在新日期的那条消息后面多一块，前面一个字节不动", () => {
	const before = withEnvironment([user("你好"), assistant("好")]);
	const after = withEnvironment([user("你好"), assistant("好"), user("第二天再问", DAY2)]);

	assert.deepEqual(after.slice(0, before.length), before, "前面的历史一个字节都没动");
	assert.equal(textOf(after.at(-2)), "第二天再问");
	assert.match(textOf(after.at(-1)), /2026-09-05/);
});

test("历史里已有的日期块原样保留，不重复接", () => {
	const once = withEnvironment([user("你好")]);
	assert.deepEqual(withEnvironment(once), once);
});

test("today 用本地时区，不是 UTC", () => {
	/*
	 * `toISOString().slice(0, 10)` 是原来的写法，它给的是 UTC 的日期——在东八区，每天早上
	 * 八点之前它都说的是昨天。一个「今天几号」答错的模型，比一个不知道今天几号的更糟。
	 */
	const newYearEveEvening = new Date(2026, 0, 1, 2, 0, 0);
	assert.equal(today(newYearEveEvening), "2026-01-01");
});

test("一轮之内日期块留在用户消息后面，回复排在它后面，请求之间前缀接得上", async () => {
	/*
	 * 主会话的日志里没有这条，每次请求重新渲染。它必须每次都落在同一个位置：上一次请求整个是这一次
	 * 的前缀，服务端缓存的「上次输入＋上次输出」才用得上；最后一条也不能是它，否则 DeepSeek 会丢掉
	 * 之前各轮的推理。
	 */
	const model = { id: "fake/model", providerId: "fake", modelId: "model", name: "Fake", contextWindow: 200_000, maxOutputTokens: 4096, supportsThinking: false, supportsImages: false, supportsTools: true };
	const reply = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage =>
		({ role: "assistant", content, api: "openai-responses", provider: "fake", model: "model", usage: emptyUsage(), stopReason, timestamp: 1 });
	const replies = [
		reply([{ type: "toolCall", id: "c1", name: "missing", arguments: {}, argumentsText: "{}" }], "toolUse"),
		reply([{ type: "text", text: "好" }], "stop"),
	];
	const sent: Message[][] = [];
	const result = await runAgent(
		runConfig({
			session: { sessionId: "s", systemPrompt: "", messages: [user("你好")], environment: true },
			model: {
				model,
				provider: { id: "fake", name: "Fake", baseUrl: "http://localhost", api: "openai-responses", apiKey: "x", enabled: true, models: [model] },
				streamFn: async (context) => {
					sent.push(context.messages);
					return replies[sent.length - 1];
				},
			},
			tools: { available: [], env: { cwd: "/tmp" } },
		}),
		async () => {},
	);

	assert.equal(sent.length, 2);
	const isEnv = (message: Message) => message.synthetic === true && message.content.some((c) => c.type === "text" && c.text.includes("<env>"));
	for (const request of sent) {
		assert.ok(isEnv(request[1]), "日期块紧跟在用户消息后面");
		assert.equal(request.filter(isEnv).length, 1, "而且只有这一条");
	}
	assert.ok(!isEnv(sent[1].at(-1)!), "有了回复之后，最后一条不是日期块");
	assert.deepEqual(sent[1].slice(0, sent[0].length), sent[0], "上一次请求整个是这一次的前缀");
	assert.ok(!result.messages.some(isEnv), "日期块不进这一轮产出的消息，也就不进日志");
});
