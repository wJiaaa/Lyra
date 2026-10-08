import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "@plume/client-runtime";
import { activityOf } from "../src/activity.ts";

const usage = (input: number, output: number) => ({ input, output, cacheRead: 500, cacheWrite: 10, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const user = (timestamp: number) => ({ role: "user", content: [{ type: "text", text: "做" }], timestamp }) as unknown as Message;
const assistant = (content: unknown[], extra: object = {}) => ({ role: "assistant", content, usage: usage(100, 20), stopReason: "toolUse", timestamp: 2000, ...extra }) as unknown as Message;
const call = (id: string, name: string, args: object) => ({ type: "toolCall", id, name, arguments: args });
const result = (id: string, timestamp: number) => ({ role: "toolResult", toolCallId: id, toolName: "x", content: [], isError: false, timestamp }) as unknown as Message;

test("一轮从最后一条用户消息算起，token 只数这一轮的回复，口径同 freshTokens（不含 cacheRead）", () => {
	const reading = activityOf([user(1), assistant([{ type: "text", text: "上一轮" }], { stopReason: "stop" }), user(1000), assistant([call("a", "read", { path: "a.ts" })])], 1500);
	assert.equal(reading.startedAt, 1000);
	assert.equal(reading.tokens, 130);
});

test("还没结果的调用决定在干什么；跑命令里带 test 的算测试", () => {
	assert.equal(activityOf([user(1000), assistant([call("a", "grep", { pattern: "x" })])], 1500).mood, "searching");
	assert.equal(activityOf([user(1000), assistant([call("a", "bash", { command: "pnpm test" })])], 1500).mood, "solving");
});

test("刚做完的一步再留两秒，过了就回到在想", () => {
	const messages = [user(1000), assistant([call("a", "edit", { path: "a.ts" })]), result("a", 3000)];
	assert.equal(activityOf(messages, 4000).mood, "shaping", "做完一秒，还挂着");
	assert.equal(activityOf(messages, 5500).mood, "breathing", "做完两秒多，模型在想下一步");
});

test("没有工具时，回复末尾在流正文是在写，在流思考是在想", () => {
	assert.equal(activityOf([user(1000), assistant([{ type: "text", text: "我先" }], { stopReason: "pending" })], 1500).mood, "composing");
	assert.equal(activityOf([user(1000), assistant([{ type: "thinking", thinking: "嗯" }], { stopReason: "pending" })], 1500).mood, "breathing");
});
