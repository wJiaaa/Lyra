import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanSessionSummary, summarizeSession, summaryMaterial, SUMMARY_MAX_CHARS } from "../src/runtime/session-summary.ts";
import type { AssistantMessage, Message, ModelConfig, ProviderConfig } from "../src/types.ts";
import { emptyUsage } from "../src/types.ts";

const MODEL: ModelConfig = { id: "p/m", providerId: "p", modelId: "m", name: "M", contextWindow: 100_000, maxOutputTokens: 4096, supportsThinking: false, supportsImages: false, supportsTools: true };
const PROVIDER: ProviderConfig = { id: "p", name: "P", baseUrl: "http://localhost", api: "openai-responses", apiKey: "x", enabled: true, models: [MODEL] };

const user = (timestamp: number, text: string, extra: Partial<Extract<Message, { role: "user" }>> = {}): Message => ({ role: "user", timestamp, content: [{ type: "text", text }], ...extra });
const assistant = (timestamp: number, content: AssistantMessage["content"]): AssistantMessage => ({
	role: "assistant", content, api: "openai-responses", provider: "p", model: "m", usage: emptyUsage(), stopReason: "stop", timestamp,
});

test("第一次给最近几条人和 agent 说的话，工具调用里只捡出改动过的文件", () => {
	const messages: Message[] = [
		user(-2, "先看看列表"),
		user(-1, "再看看详情"),
		user(1, "修一下滚动位置"),
		assistant(2, [{ type: "toolCall", id: "a", name: "edit", arguments: { path: "src/scroll.ts" } }, { type: "toolCall", id: "b", name: "read", arguments: { path: "src/other.ts" } }]),
		{ role: "toolResult", toolCallId: "a", toolName: "edit", content: [{ type: "text", text: "工具输出不该进材料" }], isError: false, timestamp: 3 },
		assistant(4, [{ type: "text", text: "改成按锚点恢复了" }]),
		user(5, "运行时插进来的", { synthetic: true }),
	];
	const material = summaryMaterial(messages);
	assert.ok(material);
	assert.equal(material.upto, 4);
	assert.match(material.prompt, /上一份摘要：\n（没有）/);
	assert.match(material.prompt, /\[用户\] 修一下滚动位置\n\[agent\] 改成按锚点恢复了/);
	assert.match(material.prompt, /src\/scroll\.ts/);
	assert.doesNotMatch(material.prompt, /src\/other\.ts|工具输出|运行时插进来的/);
});

test("有上一份时只给它之后的消息；之后没人再说话就不用再要", () => {
	const messages: Message[] = [user(1, "旧问题"), assistant(2, [{ type: "text", text: "旧回答" }]), user(3, "新问题"), user(4, "再补一句")];
	const previous = { text: "在修旧问题。", upto: 2 };
	const material = summaryMaterial(messages, previous);
	assert.ok(material);
	assert.equal(material.upto, 4);
	assert.match(material.prompt, /上一份摘要：\n在修旧问题。/);
	assert.doesNotMatch(material.prompt, /旧问题\n|旧回答/);
	assert.equal(summaryMaterial(messages, { text: "x", upto: 4 }), null);
	assert.equal(summaryMaterial([]), null);
});

test("人说得不够多就不要：第一次要人说过三句，之后每次要人又说了两句；运行时插进来的不算", () => {
	const reply = (at: number) => assistant(at, [{ type: "text", text: "好" }]);
	const two: Message[] = [user(1, "一"), reply(2), user(3, "二"), reply(4)];
	assert.equal(summaryMaterial(two), null);
	assert.equal(summaryMaterial([...two, user(5, "子 Agent 的结果", { synthetic: true }), reply(6)]), null);
	const three: Message[] = [...two, user(5, "三"), reply(6)];
	assert.ok(summaryMaterial(three));

	const previous = { text: "x", upto: 6 };
	assert.equal(summaryMaterial([...three, user(7, "四"), reply(8)], previous), null);
	assert.ok(summaryMaterial([...three, user(7, "四"), reply(8), user(9, "五"), reply(10)], previous));
});

test("清掉前缀、引号、换行，超长的截到卡片放得下", () => {
	assert.equal(cleanSessionSummary("摘要：「在修滚动。\n下一步提交。」"), "在修滚动。 下一步提交。");
	assert.equal(cleanSessionSummary("<think>想想</think>```\nRecap: done\n```"), "done");
	const long = cleanSessionSummary("字".repeat(400));
	assert.equal([...long].length, SUMMARY_MAX_CHARS);
	assert.ok(long.endsWith("…"));
});

test("一次请求：拿到的文字成为新摘要，出错时不覆盖，没有新材料不发请求", async () => {
	let calls = 0;
	const stream = (text: string, stopReason: AssistantMessage["stopReason"] = "stop") => (() => {
		calls++;
		return (async function* () {
			const message = { ...assistant(9, [{ type: "text", text }]), stopReason };
			yield { type: "done" as const, reason: "stop" as const, message };
			return message;
		})();
	}) as never;
	const messages = [user(-1, "看看"), user(0, "还有这里"), user(1, "修滚动"), assistant(2, [{ type: "text", text: "修好了" }])];

	const ok = await summarizeSession({ messages, provider: PROVIDER, model: MODEL, stream: stream("在修滚动，已修好。") });
	assert.deepEqual(ok?.summary, { text: "在修滚动，已修好。", upto: 2 });

	const failed = await summarizeSession({ messages, provider: PROVIDER, model: MODEL, stream: stream("", "error") });
	assert.equal(failed?.summary, null);
	assert.ok(failed?.error);

	const before = calls;
	assert.equal(await summarizeSession({ messages, previous: { text: "x", upto: 2 }, provider: PROVIDER, model: MODEL, stream: stream("不该发") }), null);
	assert.equal(calls, before);
});
