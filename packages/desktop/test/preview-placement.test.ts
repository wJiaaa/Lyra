/**
 * 一轮里 agent 放出来给人看的页面，站在哪。
 *
 * 页面是这一轮的结果，不是过程：跑着的时候它出现在它被放出来的地方，跑完之后它站在「已工作」那一行
 * 之后、回答之前，永远不跟着过程一起收起来。规则在 `grouping.ts`，判错了不报错，只是页面看不见。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "@plume/core";

import { runs, turnBlocks, wholeTurns, blockRuns, type Run, type TranscriptBlock } from "../src/features/conversation/grouping.ts";

let clock = 1000;
const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: clock++ }) as Message;
const calls = (...names: string[]): Message =>
	({
		role: "assistant",
		// `preview?` is a preview called with `check: true`.
		content: names.map((name) => ({ type: "toolCall", id: `${name}-${clock}`, name: name.replace("?", ""), arguments: name.endsWith("?") ? { check: true } : {} })),
		stopReason: "toolUse",
		timestamp: clock++,
	}) as Message;
const result = (call: Message, index: number, isError = false): Message =>
	({
		role: "toolResult",
		toolCallId: (call.content[index] as { id: string }).id,
		toolName: (call.content[index] as { name: string }).name,
		content: [{ type: "text", text: "ok" }],
		isError,
		timestamp: clock++,
	}) as Message;
const answer = (text: string): Message => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: clock++ }) as Message;

/** One line per row: what the reader sees, in order, with `fold[…]` for what the turn line hides. */
function describe(blocks: TranscriptBlock[]): string[] {
	const name = (run: Run) =>
		run.kind === "tools" ? `${run.shown ? "page" : "work"}(${run.calls.map((c) => c.block.name).join(",")})` : run.kind === "message" ? run.message.role : run.kind;
	return blocks.map((block) => (block.kind === "fold" ? `fold[${blockRuns(block).map(name).join(" ")}]` : block.runs.map(name).join(" ")));
}

test("页面自成一行，不和前后的工具调用并成一组", () => {
	const reply = calls("read", "preview", "grep");
	const rows = runs([user("画个图"), reply, result(reply, 0), result(reply, 1), result(reply, 2)]);
	assert.deepEqual(
		rows.map((row) => (row.kind === "tools" ? `${row.shown ? "page" : "work"}:${row.calls.length}` : row.kind)),
		["message", "work:1", "page:1", "work:1"],
	);
});

test("跑完之后，页面站在「已工作」之后、回答之前；工具照旧收起来", () => {
	const look = calls("read", "glob");
	const draw = calls("preview");
	const more = calls("read");
	const messages = [user("画个图"), look, result(look, 0), result(look, 1), draw, result(draw, 0), more, result(more, 0), answer("图里的峰值在三月。")];
	assert.deepEqual(describe(wholeTurns(turnBlocks(runs(messages)), false)), ["user", "fold[work(read,glob) work(read)]", "page(preview)", "assistant"]);
});

test("跑着的时候，页面就在它被放出来的地方，不在过程里", () => {
	const look = calls("read");
	const draw = calls("preview");
	const messages = [user("画个图"), look, result(look, 0), draw];
	const blocks = wholeTurns(turnBlocks(runs(messages)), true);
	assert.deepEqual(describe(blocks), ["user", "fold[]", "work(read)", "page(preview)"]);
	assert.equal(blocks[2].kind, "process");
	assert.equal(blocks[3].kind, "plain", "页面不是过程，跑着时也不收");
});

test("没展示出来的预览（页面抛异常被拒）是普通的活，跟着过程收起来", () => {
	const broken = calls("preview");
	const fixed = calls("preview");
	const messages = [user("画个图"), broken, result(broken, 0, true), fixed, result(fixed, 0), answer("好了。")];
	assert.deepEqual(describe(wholeTurns(turnBlocks(runs(messages)), false)), ["user", "fold[work(preview)]", "page(preview)", "assistant"]);
});

test("只放了页面、没有别的过程的一轮，不加「已工作」这一行", () => {
	const draw = calls("preview");
	const messages = [user("画个图"), draw, result(draw, 0), answer("这是三月的数据。")];
	assert.deepEqual(describe(wholeTurns(turnBlocks(runs(messages)), false)), ["user", "page(preview)", "assistant"]);
});

test("模型先检查页面再发布：检查是过程，跟着收起来；只有发布的那次是页面", () => {
	const check = calls("preview?");
	const publish = calls("preview");
	const messages = [user("画个图"), check, result(check, 0), publish, result(publish, 0), answer("好了。")];
	assert.deepEqual(describe(wholeTurns(turnBlocks(runs(messages)), false)), ["user", "fold[work(preview)]", "page(preview)", "assistant"]);
	const live = wholeTurns(turnBlocks(runs([user("画个图"), check])), true);
	assert.deepEqual(describe(live), ["user", "fold[]", "work(preview)"], "检查跑着的时候也不占一行页面");
});
