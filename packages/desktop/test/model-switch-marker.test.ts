/**
 * 换了模型的那条分隔落在哪。
 *
 * 认的是回复上记的模型，不是「切换」那个动作：只在菜单里换一下、一句没发，转录里什么也不该出现。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { AssistantContent, AssistantMessage, Message } from "@plume/core";
import { emptyUsage } from "@plume/core";

import { runs, type Run } from "../src/features/conversation/grouping.ts";

function user(text: string): Message {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function reply(provider: string, model: string, content: AssistantContent[] = [{ type: "text", text: "好" }]): AssistantMessage {
	return { role: "assistant", content, api: "anthropic-messages", provider, model, usage: emptyUsage(), stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop", timestamp: 1 };
}

/** 每一行写成一个字：用户消息是它的原话，回复是 `a`，分隔是 `from→to`，工具是 `tools`。 */
function shape(list: Run[]): string[] {
	return list.map((run) => {
		if (run.kind === "model") return `${run.from.provider}/${run.from.model}→${run.to.provider}/${run.to.model}`;
		if (run.kind === "message") return run.message.role === "user" ? (run.message.content[0] as { text: string }).text : "a";
		return run.kind;
	});
}

test("两轮之间换了模型，分隔落在开新一轮的那句话上面", () => {
	assert.deepEqual(shape(runs([user("一"), reply("p", "m1"), user("二"), reply("p", "m2")])), ["一", "a", "p/m1→p/m2", "二", "a"]);
});

test("一直是同一个模型，什么也不画；同名模型换了服务商就是换了", () => {
	assert.deepEqual(shape(runs([user("一"), reply("p", "m"), user("二"), reply("p", "m")])), ["一", "a", "二", "a"]);
	assert.deepEqual(shape(runs([user("一"), reply("p", "m"), user("二"), reply("q", "m")])), ["一", "a", "p/m→q/m", "二", "a"]);
});

test("只换了模型、新的一句还没得到回答，不画", () => {
	assert.deepEqual(shape(runs([user("一"), reply("p", "m1"), user("二")])), ["一", "a", "二"]);
});

test("一轮当中才生效的切换，落在第一条新回复上面", () => {
	const call: AssistantContent = { type: "toolCall", id: "c1", name: "read", arguments: { path: "/tmp/a.ts" } };
	const result: Message = { role: "toolResult", toolCallId: "c1", toolName: "read", content: [], isError: false, timestamp: 1 };
	assert.deepEqual(shape(runs([user("一"), reply("p", "m1", [call]), result, reply("p", "m2")])), ["一", "tools", "p/m1→p/m2", "a"]);
});

test("没得到回答的那句不背这条分隔，它落在真正换了模型回答的那句上面", () => {
	assert.deepEqual(shape(runs([user("一"), reply("p", "m1"), user("二"), user("三"), reply("p", "m2")])), ["一", "a", "二", "p/m1→p/m2", "三", "a"]);
});
