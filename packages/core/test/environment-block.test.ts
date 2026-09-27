/**
 * 日期放在前缀末尾，而不是 system prompt 里。
 *
 * 这条测的是**位置**，而位置就是全部的意义。前缀缓存从最前面逐段匹配，system prompt 正是最
 * 前面那一段——里面放一个每天变一次的字符串，等于每天头一次请求要为整个对话重付一次全额。
 * 一个几十万 token 的长会话，为了一句「今天是几号」。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { today, withEnvironment } from "../src/prompt/environment.ts";
import { buildSystemPrompt } from "../src/prompt/system.ts";
import { runAgent } from "../src/agent/loop.ts";
import type { AssistantMessage, Message } from "../src/types.ts";
import { emptyUsage } from "../src/types.ts";

const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: 0 });

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

test("日期接在消息末尾", async () => {
	const messages = withEnvironment([user("你好"), user("再问一句")]);
	const last = messages.at(-1);

	assert.equal(messages.length, 3);
	assert.equal(last?.role, "user");
	assert.match(last?.content[0].type === "text" ? last.content[0].text : "", new RegExp(today()));
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

test("同一天里两次拼装出的前缀一模一样", () => {
	/*
	 * 缓存要的就是这个。日期以外的东西（`Date.now()` 的时间戳）不能进到模型看得见的文本里，
	 * 否则每一轮的末尾都不同，而这块又在前缀里——那就比放在 system prompt 里还糟。
	 */
	const a = withEnvironment([user("你好")]);
	const b = withEnvironment([user("你好")]);
	const textOf = (messages: Message[]) => messages.map((m) => m.content.map((c) => (c.type === "text" ? c.text : "")).join()).join("|");

	assert.equal(textOf(a), textOf(b));
});

test("跨天时变的只有末尾这一块", () => {
	const yesterday = withEnvironment([user("你好")], "2026-09-04");
	const todayOne = withEnvironment([user("你好")], "2026-09-05");

	assert.deepEqual(yesterday.slice(0, -1), todayOne.slice(0, -1), "前面的历史一个字节都没动");
	assert.notDeepEqual(yesterday.at(-1), todayOne.at(-1));
});

test("today 用本地时区，不是 UTC", () => {
	/*
	 * `toISOString().slice(0, 10)` 是原来的写法，它给的是 UTC 的日期——在东八区，每天早上
	 * 八点之前它都说的是昨天。一个「今天几号」答错的模型，比一个不知道今天几号的更糟。
	 */
	const newYearEveEvening = new Date(2026, 0, 1, 2, 0, 0);
	assert.equal(today(newYearEveEvening), "2026-01-01");
});

test("一轮之内每次请求都把日期块接在最末尾，回复不会排在它后面", async () => {
	/*
	 * 主会话的日志里没有这条。只在一轮开头接一次的话，这一轮的工具往返都排在它后面，下一轮从日志
	 * 重建时它不在原位了——前缀从那里断开，上一轮整段重写缓存。
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
		{
			sessionId: "s", cwd: "/tmp", systemPrompt: "", tools: [], messages: [user("你好")], environment: true, model,
			provider: { id: "fake", name: "Fake", baseUrl: "http://localhost", api: "openai-responses", apiKey: "x", enabled: true, models: [model] },
			streamFn: async (context) => {
				sent.push(context.messages);
				return replies[sent.length - 1];
			},
		},
		async () => {},
	);

	assert.equal(sent.length, 2);
	const isEnv = (message: Message) => message.synthetic === true && message.content.some((c) => c.type === "text" && c.text.includes("<env>"));
	for (const request of sent) {
		assert.ok(isEnv(request.at(-1)!), "每次请求的最后一条都是日期块");
		assert.equal(request.filter(isEnv).length, 1, "而且只有这一条");
	}
	assert.deepEqual(sent[1].slice(0, sent[0].length - 1), sent[0].slice(0, -1), "上一次请求去掉日期块后是这一次的前缀");
	assert.ok(!result.messages.some(isEnv), "日期块不进这一轮产出的消息，也就不进日志");
});
