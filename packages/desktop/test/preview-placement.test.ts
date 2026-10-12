/**
 * 一轮里 agent 放出来给人看的页面，站在哪。
 *
 * 页面是这一轮的结果，不是过程：它出现在它被放出来的地方，永远不跟着过程一起收起来。规则在
 * `grouping.ts`，判错了不报错，只是页面看不见。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "@plume/core";

import { runs, turnBlocks, type Run, type TurnBlock } from "../src/features/conversation/grouping.ts";

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

/** One line per row: what the reader sees, in order, with `process[…]` for what a process line folds. */
function describe(blocks: TurnBlock[]): string[] {
	const name = (run: Run) =>
		run.kind === "tools" ? `${run.shown ? "page" : "work"}(${run.calls.map((c) => c.block.name).join(",")})` : run.kind === "message" ? run.message.role : run.kind;
	return blocks.map((block) => (block.kind === "process" ? `process[${block.runs.map(name).join(" ")}]` : block.runs.map(name).join(" ")));
}

test("页面自成一行，不和前后的工具调用并成一组", () => {
	const reply = calls("read", "preview", "grep");
	const rows = runs([user("画个图"), reply, result(reply, 0), result(reply, 1), result(reply, 2)]);
	assert.deepEqual(
		rows.map((row) => (row.kind === "tools" ? `${row.shown ? "page" : "work"}:${row.calls.length}` : row.kind)),
		["message", "work:1", "page:1", "work:1"],
	);
});

test("页面站在它被放出来的地方，不收进前后的过程", () => {
	const look = calls("read", "glob");
	const draw = calls("preview");
	const more = calls("read");
	const messages = [user("画个图"), look, result(look, 0), result(look, 1), draw, result(draw, 0), more, result(more, 0), answer("图里的峰值在三月。")];
	assert.deepEqual(describe(turnBlocks(runs(messages))), ["user", "process[work(read,glob)]", "page(preview)", "process[work(read)]", "assistant"]);
});

test("跑着的时候，页面也不在过程里", () => {
	const look = calls("read");
	const draw = calls("preview");
	const blocks = turnBlocks(runs([user("画个图"), look, result(look, 0), draw]));
	assert.deepEqual(describe(blocks), ["user", "process[work(read)]", "page(preview)"]);
	assert.equal(blocks[2].kind, "plain", "页面不是过程，跑着时也不收");
});

test("没展示出来的预览（页面抛异常被拒）是普通的活，跟着过程收起来", () => {
	const broken = calls("preview");
	const fixed = calls("preview");
	const messages = [user("画个图"), broken, result(broken, 0, true), fixed, result(fixed, 0), answer("好了。")];
	assert.deepEqual(describe(turnBlocks(runs(messages))), ["user", "process[work(preview)]", "page(preview)", "assistant"]);
});

test("模型先检查页面再发布：检查是过程，跟着收起来；只有发布的那次是页面", () => {
	const check = calls("preview?");
	const publish = calls("preview");
	const messages = [user("画个图"), check, result(check, 0), publish, result(publish, 0), answer("好了。")];
	assert.deepEqual(describe(turnBlocks(runs(messages))), ["user", "process[work(preview)]", "page(preview)", "assistant"]);
	assert.deepEqual(describe(turnBlocks(runs([user("画个图"), check]))), ["user", "process[work(preview)]"], "检查跑着的时候也不占一行页面");
});

test("经 mcp_call 叫的 MCP 工具按真正那个工具排：名字和参数都是它自己的", () => {
	const via: Message = {
		role: "assistant",
		content: [{ type: "toolCall", id: "routed-mcp", name: "mcp_call", arguments: { tool: "mcp__linear__create_issue", arguments: { title: "Bug" } } }],
		stopReason: "toolUse",
		timestamp: clock++,
	} as Message;
	const done: Message = { role: "toolResult", toolCallId: "routed-mcp", toolName: "mcp__linear__create_issue", content: [{ type: "text", text: "ok" }], isError: false, timestamp: clock++ } as Message;
	const rows = runs([user("建个 issue"), via, done, answer("建好了。")]);
	const tools = rows.find((row) => row.kind === "tools");
	assert.ok(tools && tools.kind === "tools");
	assert.equal(tools.calls[0]!.block.name, "mcp__linear__create_issue");
	assert.deepEqual(tools.calls[0]!.block.arguments, { title: "Bug" });
});
