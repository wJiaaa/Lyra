import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "@plume/core";
import { drawnAt, messageEvent } from "../src/store/message-event.ts";
import { proseGrewAt } from "../src/features/conversation/answering.ts";

const pending: Message = { role: "user", content: [{ type: "text", text: "相同的问题" }], timestamp: 1 };
const confirmed: Message = { ...pending, timestamp: 2 };

test("only the pending message's session may confirm it, regardless of text", () => {
	const state = { messages: [pending], pendingUserMessage: { sessionId: "a", message: pending } };
	const other = messageEvent(state, { type: "message_start", message: confirmed }, "b");
	assert.equal(other.pendingUserMessage, state.pendingUserMessage);
	assert.equal(other.messages[0], pending);
	const own = messageEvent(state, { type: "message_start", message: confirmed }, "a");
	assert.equal(own.pendingUserMessage, null);
	assert.deepEqual(own.messages, [confirmed]);
});

test("an uncreated draft is never a wildcard for an existing session", () => {
	const state = { messages: [pending], pendingUserMessage: { sessionId: null, message: pending } };
	const next = messageEvent(state, { type: "message_start", message: confirmed }, "a");
	assert.equal(next.pendingUserMessage, state.pendingUserMessage);
	assert.equal(next.messages[0], pending);
});

test("confirmation replaces the exact pending reference, preserving repeated prompts", () => {
	const earlier: Message = { ...pending, timestamp: 0 };
	const state = { messages: [earlier, pending], pendingUserMessage: { sessionId: "a", message: pending } };
	const next = messageEvent(state, { type: "message_end", message: confirmed }, "a");
	assert.deepEqual(next.messages, [earlier, confirmed]);
	assert.equal(next.pendingUserMessage, null);
});

test("the committed copy keeps the row the optimistic one was drawn in, through start and end", () => {
	const state = { messages: [pending], pendingUserMessage: { sessionId: "a", message: pending } };
	const started = messageEvent(state, { type: "message_start", message: confirmed }, "a");
	assert.equal(drawnAt(started.messages[0]), pending.timestamp);
	// message_end 送来的是另一个对象，按运行时的时间戳认领那一格；画在哪一行照旧。
	const ended = messageEvent(started, { type: "message_end", message: { ...confirmed } }, "a");
	assert.equal(ended.messages[0].timestamp, confirmed.timestamp);
	assert.equal(drawnAt(ended.messages[0]), pending.timestamp);
});

test("a message nobody drew earlier is keyed by its own timestamp", () => {
	const reply: Message = { role: "user", content: [{ type: "text", text: "另一句" }], timestamp: 5 };
	const next = messageEvent({ messages: [], pendingUserMessage: null }, { type: "message_start", message: reply }, "a");
	assert.equal(drawnAt(next.messages[0]), 5);
});

test("a reply's prose remembers when it last grew, not when it was last delivered", (t) => {
	// 运行行的停顿从这一刻算起；切会话不经过这里，所以切回来不会让钟重新走。
	let now = 1_000;
	t.mock.method(Date, "now", () => now);
	const reply = (text: string): Message => ({
		role: "assistant", content: [{ type: "thinking", thinking: "先想" }, ...(text ? [{ type: "text" as const, text }] : [])],
		api: "anthropic-messages", provider: "p", model: "m", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "pending", timestamp: 10,
	});
	let state = { messages: [] as Message[], pendingUserMessage: null };
	state = messageEvent(state, { type: "message_start", message: reply("") }, "a");
	assert.equal(proseGrewAt(state.messages[0]), undefined, "no prose yet, so nothing is being written");
	state = messageEvent(state, { type: "message_update", message: reply("第一句"), delta: { type: "text_delta" } } as never, "a");
	assert.equal(proseGrewAt(state.messages[0]), 1_000);
	now = 5_000;
	// 同样长的一次更新（用量刷新、签名到了）不算字在长。
	state = messageEvent(state, { type: "message_update", message: reply("第一句"), delta: { type: "text_delta" } } as never, "a");
	assert.equal(proseGrewAt(state.messages[0]), 1_000, "an update that added no words restarted the stall");
	state = messageEvent(state, { type: "message_update", message: reply("第一句，第二句"), delta: { type: "text_delta" } } as never, "a");
	assert.equal(proseGrewAt(state.messages[0]), 5_000);
});
