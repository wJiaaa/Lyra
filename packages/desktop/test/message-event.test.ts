import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "@plume/core";
import { drawnAt, messageEvent } from "../src/store/message-event.ts";

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
