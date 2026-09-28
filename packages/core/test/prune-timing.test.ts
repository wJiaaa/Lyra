/**
 * Which cuts are worth making at all, and which results are worth nothing to begin with.
 *
 * Nothing here looks at time: a result's view depends on the result alone, so the send path can
 * decide it once, before the first send, and rebuild the same copy on every later request.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { dropUneventful, PRUNE_FLOOR_CHARS, pruneText } from "../src/runtime/prune.ts";
import type { Message, ToolResultMessage } from "../src/types.ts";

function result(text: string, uneventful = false): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: `c-${text.length}-${uneventful}`,
		toolName: "grep",
		content: [{ type: "text", text }],
		isError: false,
		uneventful,
		timestamp: 0,
	};
}

function user(text: string): Message {
	return { role: "user", content: [{ type: "text", text }], timestamp: 0 };
}

// ---------------------------------------------------------------------------
// The floor
// ---------------------------------------------------------------------------

test("a result smaller than the marker is left alone", () => {
	/*
	 * The marker is prose and runs to a couple of hundred characters. Cutting a 150-character
	 * result to insert it saves nothing and rewrites history to do it.
	 */
	assert.equal(pruneText("x".repeat(150), 10), null);
});

test("above the floor, cutting happens as before", () => {
	const cut = pruneText("x".repeat(10_000));
	assert.ok(cut);
	assert.ok(cut.length < 10_000);
});

// ---------------------------------------------------------------------------
// Uneventful results
// ---------------------------------------------------------------------------

test("an uneventful result is emptied, not removed", () => {
	/*
	 * The pairing is the reason. A `tool_use` whose `tool_result` is missing makes Anthropic reject
	 * the request — and every later one carrying the same history, including the one sent to
	 * recover from it. One orphan does not spoil a turn, it spoils the conversation.
	 */
	const messages = [result("没有匹配。".repeat(200), true), user("短")];
	const after = dropUneventful(messages);

	assert.equal(after.length, messages.length, "the message is still there");
	assert.equal(after[0].role, "toolResult");
	assert.equal((after[0] as ToolResultMessage).toolCallId, (messages[0] as ToolResultMessage).toolCallId, "and still paired");
	assert.match((after[0].content[0] as { text: string }).text, /无结果/);
});

test("a result with content is untouched even when it is enormous", () => {
	const messages = [result("真实的搜索结果".repeat(2000), false), user("短")];
	assert.equal(dropUneventful(messages), messages, "same array, nothing allocated");
});

test("a tiny uneventful result is left as it is", () => {
	const messages = [result("x".repeat(PRUNE_FLOOR_CHARS - 1), true), user("短")];
	assert.equal(dropUneventful(messages), messages);
});

test("nothing to do returns the same array", () => {
	const messages = [user("a"), result("b")];
	assert.equal(dropUneventful(messages), messages);
});
