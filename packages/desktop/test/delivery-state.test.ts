import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyUsage, type Message } from "@plume/core";
import { latestDeliveryTimestamp } from "../src/features/conversation/delivery-state.ts";

test("only the latest completed answer owns a delivery; a new question or active run retires it", () => {
	const answer: Message = { role: "assistant", api: "openai-responses", provider: "qa", model: "qa", content: [], timestamp: 2, stopReason: "stop", usage: emptyUsage() };
	const user: Message = { role: "user", content: [], timestamp: 1 };
	assert.equal(latestDeliveryTimestamp([user, answer], false), 2);
	assert.equal(latestDeliveryTimestamp([user, answer], true), null);
	assert.equal(latestDeliveryTimestamp([user, answer, { ...user, timestamp: 3 }], false), null);
	assert.equal(latestDeliveryTimestamp([user, { ...answer, stopReason: "toolUse" }], false), null);
	assert.equal(latestDeliveryTimestamp([user, answer, { ...user, synthetic: true }, { ...answer, timestamp: 4 }], false), 4);
});

test("ticking the plan after the answer leaves the delivery with the answer", () => {
	const user: Message = { role: "user", content: [], timestamp: 1 };
	const answer: Message = { role: "assistant", api: "openai-responses", provider: "qa", model: "qa", content: [{ type: "text", text: "做完了" }], timestamp: 2, stopReason: "stop", usage: emptyUsage() };
	const asked: Message = { role: "user", content: [{ type: "text", text: "（自动提示）任务清单里还有 1 项没勾" }], timestamp: 3, synthetic: true };
	const tick: Message = { ...answer, content: [{ type: "toolCall", id: "t", name: "todo_write", arguments: { todos: [] } }], timestamp: 4, stopReason: "toolUse" };
	const ticked: Message = { role: "toolResult", toolCallId: "t", toolName: "todo_write", content: [], isError: false, timestamp: 5 };
	assert.equal(latestDeliveryTimestamp([user, answer, asked, tick, ticked], false), 2);
	const read: Message = { ...tick, content: [{ type: "toolCall", id: "r", name: "read", arguments: {} }] };
	assert.equal(latestDeliveryTimestamp([user, answer, asked, read, { ...ticked, toolCallId: "r", toolName: "read" }], false), null, "real work after the answer is still work in progress");
});
