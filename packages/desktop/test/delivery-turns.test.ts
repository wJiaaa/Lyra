/**
 * 后台结果送回来时，算不算新的一轮。
 *
 * 插在一轮中间的（`steered`）不算：主智能体一直在干活，它是这段工作里的一步。从前它一律被当成
 * 「开了一轮」，一段连续的工作被切成两轮、两个锚。把空闲的会话
 * 叫醒的那一种照旧开一轮；人插的话也照旧开一轮。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { AssistantContent, AssistantMessage, Message, StopReason } from "@plume/core";
import { emptyUsage } from "@plume/core";

import { computeTurnStats, runs, turnBlocks } from "../src/features/conversation/grouping.ts";

const user = (text: string, extra: Partial<Extract<Message, { role: "user" }>> = {}): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: 1, ...extra });

const delivery = (steered: boolean): Message =>
	user("（运行时送达）", { synthetic: true, delivery: [{ id: "j1", kind: "job", agent: "", description: "render", status: "done" }], ...(steered ? { steered: true as const } : {}) });

function assistant(content: AssistantContent[], stopReason: StopReason): AssistantMessage {
	return { role: "assistant", content, api: "anthropic-messages", provider: "p", model: "m", usage: emptyUsage(), stopReason, timestamp: 1 };
}

const calls = (id: string) => assistant([{ type: "thinking", thinking: "想想" }, { type: "toolCall", id, name: "read", arguments: {} }], "toolUse");
const result = (id: string): Message => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [], isError: false, timestamp: 1 });
const answer = assistant([{ type: "text", text: "做完了。" }], "stop");

const shape = (messages: Message[]) => turnBlocks(runs(messages));

test("插在一轮中间的送达收进这段工作里，不切开它，也不开新的一轮", () => {
	const messages = [user("渲染一下"), calls("a"), result("a"), delivery(true), calls("b"), result("b"), answer];
	const blocks = shape(messages);
	assert.deepEqual(blocks.map((b) => b.kind), ["plain", "work"], "问题、一整轮");
	assert.equal(new Set(blocks.map((b) => b.turn)).size, 1, "只有一轮");
	assert.ok(
		blocks[1].items.some((item) => item.kind === "run" && item.fold && item.run.kind === "message" && item.run.message.role === "user"),
		"送达那一行还在，跟着过程收",
	);
	assert.equal(computeTurnStats(messages, messages.length - 1).startIndex, 0, "这一轮从人开口算起");
});

test("跑着的时候也一样：送达之后的工作还是同一段过程", () => {
	const blocks = shape([user("渲染一下"), calls("a"), result("a"), delivery(true), calls("b")]);
	assert.deepEqual(blocks.map((b) => b.kind), ["plain", "work"]);
	assert.equal(new Set(blocks.map((b) => b.turn)).size, 1);
});

test("把空闲的会话叫醒的送达开新的一轮，画在外面", () => {
	const messages = [user("渲染一下"), answer, delivery(false), calls("b"), result("b"), answer];
	const blocks = shape(messages);
	assert.deepEqual(blocks.map((b) => b.kind), ["plain", "plain", "plain", "work"]);
	assert.equal(blocks[2].turn, blocks[0].turn + 1, "送达那一行开了第二轮");
	assert.equal(computeTurnStats(messages, messages.length - 1).startIndex, 2, "第二轮的账从送达算起");
});

test("人插的话照旧开新的一轮", () => {
	const blocks = shape([user("渲染一下"), calls("a"), result("a"), user("换个颜色", { steered: true }), calls("b"), result("b"), answer]);
	assert.equal(new Set(blocks.map((b) => b.turn)).size, 2);
});
