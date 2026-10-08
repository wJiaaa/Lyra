import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "@plume/client-runtime";
import { buildFeed, findStep, flatten } from "../src/feed.ts";

const user = (text: string, timestamp = 1, images: object[] = []) => ({ role: "user", content: [{ type: "text", text }, ...images], timestamp }) as unknown as Message;
const assistant = (content: unknown[], extra: object = {}) => ({ role: "assistant", content, timestamp: 2, ...extra }) as unknown as Message;
const call = (id: string, name: string, args: object) => ({ type: "toolCall", id, name, arguments: args });
const result = (id: string, text: string, isError = false, details?: object) => ({ role: "toolResult", toolCallId: id, toolName: "x", content: [{ type: "text", text }], isError, details, timestamp: 3 }) as unknown as Message;

test("工具调用与结果按 id 合成一步，相邻步骤并成一组，正文把组切开", () => {
	const feed = buildFeed([
		user("看看", 1, [{ type: "image", data: "", mimeType: "image/png" }]),
		assistant([call("a", "read", { path: "README.md" }), call("b", "bash", { command: "ls" })]),
		result("b", "out-b"),
		result("a", "out-a"),
		assistant([call("c", "grep", { pattern: "x" })]),
		result("c", "boom", true),
		assistant([{ type: "text", text: "完成" }, call("d", "read", { path: "a.ts" })]),
	], true);
	assert.deepEqual(feed.map((item) => item.kind), ["user", "steps", "text", "steps"], "正在跑的一轮不折");
	const first = feed[0]!;
	assert.ok(first.kind === "user" && first.text === "看看" && first.images.length === 1);
	const steps = feed[1]!;
	assert.ok(steps.kind === "steps" && steps.live);
	assert.deepEqual(steps.steps.map((step) => [step.id, step.output, step.failed]), [["a", "out-a", false], ["b", "out-b", false], ["c", "boom", true]]);
	const last = feed[3]!;
	assert.ok(last.kind === "steps" && !last.steps[0]!.done, "还没回结果的一步保持进行中");
});

test("做完的一轮：过程折成一行，最终回答和结尾留在外面，展开后原样接回", () => {
	const messages = [
		user("改一下", 1000),
		assistant([{ type: "thinking", thinking: "先读" }, call("a", "read", { path: "src/a.ts" })], { timestamp: 2000 }),
		result("a", "…"),
		assistant([{ type: "text", text: "我来改" }, call("b", "edit", { path: "src/a.ts" })], { timestamp: 3000 }),
		result("b", "ok", false, { kind: "edit", added: 3, removed: 1 }),
		assistant([{ type: "text", text: "改好了" }], { timestamp: 4000, durationMs: 500 }),
	];
	const feed = buildFeed(messages);
	assert.deepEqual(feed.map((item) => item.kind), ["user", "fold", "text", "footer"]);
	const fold = feed[1]!;
	assert.ok(fold.kind === "fold");
	assert.equal(fold.steps.length, 2);
	assert.equal(fold.thinking, 1);
	assert.equal(fold.durationMs, 3500, "从这句话到最后一条回复结束");
	assert.deepEqual(fold.children.map((item) => item.kind), ["thinking", "steps", "text", "steps"], "中间的旁白也算过程");
	const footer = feed[3]!;
	assert.ok(footer.kind === "footer" && footer.text === "改好了");
	const rows = flatten(feed, new Set([fold.key]));
	assert.deepEqual(rows.map((row) => row.item.kind), ["user", "fold", "thinking", "steps", "text", "steps", "text", "footer"]);
	assert.deepEqual(rows.map((row) => row.nested), [false, false, true, true, true, true, false, false], "只有展开的过程挂在细线上");
	assert.equal(findStep(feed, "b")?.output, "ok", "折起来的步骤也找得到，详情面板靠它拿到后到的结果");
});

test("只说话没动手的一轮不折；出错停下的最后一轮给重试，更早的不给", () => {
	const plain = buildFeed([user("你好"), assistant([{ type: "text", text: "你好！" }])]);
	assert.deepEqual(plain.map((item) => item.kind), ["user", "text", "footer"]);

	const failed = buildFeed([
		user("第一句"), assistant([], { stopReason: "error", errorMessage: "429" }),
		user("第二句", 5), assistant([call("a", "bash", { command: "ls" })]), result("a", "x"), assistant([], { stopReason: "error", errorMessage: "401" }),
	]);
	assert.deepEqual(failed.map((item) => item.kind), ["user", "error", "user", "fold", "error"]);
	const early = failed[1]!; const late = failed[4]!;
	assert.ok(early.kind === "error" && early.retry === undefined);
	assert.ok(late.kind === "error" && late.retry === "第二句");
});

test("空白正文和思考不占行", () => {
	const feed = buildFeed([assistant([{ type: "thinking", thinking: "  " }, { type: "text", text: "\n" }], { stopReason: "error", errorMessage: "401" })]);
	assert.deepEqual(feed.map((item) => item.kind), ["error"]);
});
