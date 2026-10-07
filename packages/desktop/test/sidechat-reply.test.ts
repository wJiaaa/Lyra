/**
 * 侧边聊天里一条回复什么时候开始占行。
 *
 * 空回复（刚 `message_start`、还没有一个 token）画出来是一个高 0 的 div，却吃掉外层列的一份 gap，
 * 把「思考中」先往下顶一截，字到了再顶一次。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantContent, AssistantMessage } from "@plume/core";
import { hasContent } from "../src/features/sidechat/reply.ts";

function reply(content: AssistantContent[], extra: Partial<AssistantMessage> = {}): AssistantMessage {
	return { role: "assistant", content, timestamp: 1, stopReason: "pending", ...extra } as AssistantMessage;
}

test("a reply that has only been announced takes no row", () => {
	assert.equal(hasContent(reply([])), false);
	assert.equal(hasContent(reply([{ type: "thinking", thinking: "" }])), false);
	assert.equal(hasContent(reply([{ type: "text", text: "" }])), false);
});

test("the first token of anything gives it a row", () => {
	assert.equal(hasContent(reply([{ type: "thinking", thinking: "先" }])), true);
	assert.equal(hasContent(reply([{ type: "text", text: "好" }])), true);
	assert.equal(hasContent(reply([{ type: "toolCall", id: "t", name: "read", arguments: {} }])), true);
});

test("redacted reasoning has nothing to read but is still drawn", () => {
	assert.equal(hasContent(reply([{ type: "thinking", thinking: "", redacted: true }])), true);
});

test("a failure with no output keeps its row, since the error is all there is", () => {
	assert.equal(hasContent(reply([], { stopReason: "error", errorMessage: "连接断了" })), true);
	assert.equal(hasContent(reply([], { stopReason: "error" })), false);
});
