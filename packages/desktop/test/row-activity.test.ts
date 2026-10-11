import assert from "node:assert/strict";
import { test } from "node:test";

import { rowActivity, sideChatRunning, sideSessionIds } from "../src/lib/row-activity.ts";

test("an idle row shows running when its side chat is running", () => {
	assert.equal(rowActivity(null, true, false), "running");
	assert.equal(rowActivity(null, true, true), "running");
});

test("a side chat does not invent an unread result after it stops", () => {
	assert.equal(rowActivity(null, false, false), null);
	assert.equal(rowActivity("done", false, true), null);
});

test("the main turn still wins while it is running or waiting", () => {
	assert.equal(rowActivity("waiting", true, false), "waiting");
	assert.equal(rowActivity("running", true, true), "running");
});

test("an unread main result yields to a live side chat", () => {
	assert.equal(rowActivity("done", true, false), "running");
	assert.equal(rowActivity("failed", true, false), "running");
});

test("sideChatRunning asks the sessions beside each conversation, attached pane or not", () => {
	const sides = { a: { default: { id: "a1" }, x1: { id: "a2" } }, b: { default: { id: "b1" } } };
	const running = (activity: Record<string, "running" | "waiting" | "done">, parent: string) => sideChatRunning(sideSessionIds({ sides }, ["a", "b"]), activity, parent);
	assert.equal(running({ a1: "running" }, "a"), true);
	assert.equal(running({ a1: "done" }, "a"), false);
	// 分屏时两个会话的侧边聊天同时开着，一边在跑不代表另一边在跑。
	assert.equal(running({ b1: "running" }, "b"), true);
	assert.equal(running({ a1: "running" }, "b"), false);
	// 一个会话旁边开着几个，后台那个还在答（或者停在审批上），这一行就还在动。
	assert.equal(running({ a2: "waiting" }, "a"), true);
	// 没开过侧边聊天的会话问起来不是错，答案是「没在跑」。
	assert.equal(sideChatRunning(sideSessionIds({ sides: {} }, ["a"]), { a1: "running" }, "a"), false);
});
