/**
 * 一轮里 agent 放出来给人看的页面，站在哪。
 *
 * 页面是这一轮的结果，不是过程：它出现在它被放出来的地方，不和过程并成一行。规则在
 * `grouping.ts`，判错了不报错，只是页面看不见。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "@plume/core";

import { runKey, runs, turnBlocks, type Run, type TurnBlock } from "../src/features/conversation/grouping.ts";

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

/** One line per row: what the reader sees, in order. `work(…)` is one line of calls. */
function describe(blocks: TurnBlock[]): string[] {
	const name = (run: Run) =>
		run.kind === "tools" ? `${run.shown ? "page" : "work"}(${run.calls.map((c) => c.block.name).join(",")})` : run.kind === "message" ? run.message.role : run.kind;
	return blocks.flatMap((block) =>
		block.kind === "work"
			? block.items.map((item) => (item.kind === "step" ? `work(${item.step.calls.map((c) => c.block.name).join(",")})` : name(item.run)))
			: block.runs.map(name),
	);
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
	assert.deepEqual(describe(turnBlocks(runs(messages))), ["user", "work(read,glob)", "page(preview)", "work(read)", "assistant"]);
});

test("跑着的时候，页面也不在过程里", () => {
	const look = calls("read");
	const draw = calls("preview");
	const blocks = turnBlocks(runs([user("画个图"), look, result(look, 0), draw]));
	assert.deepEqual(describe(blocks), ["user", "work(read)", "page(preview)"], "页面不是过程，跑着时也不收");
});

test("没展示出来的预览（页面抛异常被拒）是普通的活，跟着过程收起来", () => {
	const broken = calls("preview");
	const fixed = calls("preview");
	const messages = [user("画个图"), broken, result(broken, 0, true), fixed, result(fixed, 0), answer("好了。")];
	assert.deepEqual(describe(turnBlocks(runs(messages))), ["user", "work(preview)", "page(preview)", "assistant"]);
});

/*
 * 先检查、再按 id 发布：检查那一次从写到发布都是页面那一格，发布那一次是过程里的一行。规则在 `preview-pages.ts`。
 */
const preview = (args: Record<string, unknown>, extra: Partial<{ argumentsText: string; stopReason: string }> = {}): Message =>
	({
		role: "assistant",
		content: [{ type: "toolCall", id: `preview-${clock}`, name: "preview", arguments: args, ...(extra.argumentsText !== undefined ? { argumentsText: extra.argumentsText } : {}) }],
		stopReason: extra.stopReason ?? "toolUse",
		timestamp: clock++,
	}) as Message;
const checked = (call: Message, page: string, isError = false): Message => ({ ...result(call, 0, isError), details: { kind: "preview-check", id: page } }) as Message;
const pageOf = (rows: Run[]) => rows.flatMap((row) => (row.kind === "tools" ? row.calls.map((call) => `${call.block.id}:${call.page ? Object.keys(call.page)[0] : "-"}`) : []));

test("同一轮里检查再发布：页面站在检查那一次上，发布那一次收进过程", () => {
	const check = preview({ check: true, html: "<p>1</p>" });
	const publish = preview({ id: "p1" });
	const messages = [user("画个图"), check, checked(check, "p1"), publish, result(publish, 0), answer("好了。")];
	assert.deepEqual(describe(turnBlocks(runs(messages))), ["user", "page(preview)", "work(preview)", "assistant"]);
	const ids = (message: Message) => (message.content[0] as { id: string }).id;
	assert.deepEqual(pageOf(runs(messages)), [`${ids(check)}:publishedBy`, `${ids(publish)}:publishing`]);
});

test("检查完、模型还在想：页面一直占着那一格，等着发布", () => {
	const check = preview({ check: true, html: "<p>1</p>" });
	assert.deepEqual(describe(turnBlocks(runs([user("画个图"), check]))), ["user", "page(preview)"], "检查跑着");
	// 一开始就是有过程的一轮：发布那一次进过程时，页面不换父元素、不重新挂。
	assert.equal(turnBlocks(runs([user("画个图"), check])).at(-1)!.kind, "work");
	assert.deepEqual(describe(turnBlocks(runs([user("画个图"), check, checked(check, "p1")]))), ["user", "page(preview)"], "检查完，下一条回复还没来");
	const thinking = { ...mixed("think:看看截图"), stopReason: "pending" } as Message;
	assert.deepEqual(describe(turnBlocks(runs([user("画个图"), check, checked(check, "p1"), thinking]))), ["user", "page(preview)", "assistant"], "模型在想");
	assert.deepEqual(pageOf(runs([user("画个图"), check, checked(check, "p1"), thinking])), [`${(check.content[0] as { id: string }).id}:waiting`]);
});

test("写着的检查：参数还只是原文时也认得出来，页面从第一笔起就在那一格", () => {
	const writing = preview({}, { argumentsText: '{"title": "待办", "check": true, "html": "<!doctype html><p>正', stopReason: "pending" });
	assert.deepEqual(describe(turnBlocks(runs([user("画个图"), writing]))), ["user", "page(preview)"]);
	assert.deepEqual(pageOf(runs([user("画个图"), writing])), [`${(writing.content[0] as { id: string }).id}:waiting`]);
});

test("发布那一次的 id 还没写完：先当它是发布，不在页面那一格里冒出来", () => {
	const check = preview({ check: true, html: "<p>1</p>" });
	const publishing = preview({}, { argumentsText: '{"id": "p', stopReason: "pending" });
	const rows = runs([user("画个图"), check, checked(check, "p1"), publishing]);
	assert.deepEqual(describe(turnBlocks(rows)), ["user", "page(preview)", "work(preview)"]);
	assert.deepEqual(pageOf(rows), [`${(check.content[0] as { id: string }).id}:waiting`, `${(publishing.content[0] as { id: string }).id}:publishing`]);
});

test("这一轮结束了还没发布：检查是过程，跟着收起来", () => {
	const check = preview({ check: true, html: "<p>1</p>" });
	const messages = [user("画个图"), check, checked(check, "p1"), answer("你先看看截图。")];
	assert.deepEqual(describe(turnBlocks(runs(messages))), ["user", "work(preview)", "assistant"]);
});

test("又检查了一版：旧的那一版收进过程，新的那一版占那一格", () => {
	const first = preview({ check: true, html: "<p>1</p>" });
	const second = preview({ check: true, html: "<p>2</p>" });
	const messages = [user("画个图"), first, checked(first, "p1"), second];
	assert.deepEqual(describe(turnBlocks(runs(messages))), ["user", "work(preview)", "page(preview)"]);
});

test("发布失败：那一页不再等，检查和发布都收进过程", () => {
	const check = preview({ check: true, html: "<p>1</p>" });
	const publish = preview({ id: "p1" });
	const messages = [user("画个图"), check, checked(check, "p1"), publish, result(publish, 0, true), answer("页面有错，我改一下。")];
	assert.deepEqual(describe(turnBlocks(runs(messages))), ["user", "work(preview,preview)", "assistant"]);
});

test("隔了一轮才发布：页面画在发布那一次上，不画回上一轮", () => {
	const check = preview({ check: true, html: "<p>1</p>" });
	const publish = preview({ id: "p1" });
	const messages = [user("画个图"), check, checked(check, "p1"), answer("你看看截图。"), user("发吧"), publish, result(publish, 0), answer("发了。")];
	assert.deepEqual(describe(turnBlocks(runs(messages))), ["user", "work(preview)", "assistant", "user", "page(preview)", "assistant"]);
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

/*
 * A reply that calls preview and then goes back to reasoning, in the same message.
 *
 * The call is not trailing (`beforeTrailingCalls`), so it stayed in the reply's own row — a row of
 * nothing but reasoning, which is process (`thinkingOnly`). The page was drawn inside that row
 * (`segments` → `PreviewCard`) and folded away with it.
 */
const mixed = (...blocks: string[]): Message =>
	({
		role: "assistant",
		content: blocks.map((block) =>
			block.startsWith("think:") ? { type: "thinking", thinking: block.slice(6) } : block.startsWith("say:") ? { type: "text", text: block.slice(4) } : { type: "toolCall", id: `${block}-${clock}`, name: block, arguments: {} },
		),
		stopReason: "toolUse",
		timestamp: clock++,
	}) as Message;

test("调用 preview 之后同一条回复里接着想：页面仍然自成一行，不在过程里", () => {
	const reply = mixed("think:先想想", "preview", "think:再看看", "read");
	const messages = [user("画一只小狗"), reply, result(reply, 1), result(reply, 3), answer("画好了。")];
	assert.deepEqual(describe(turnBlocks(runs(messages))), ["user", "assistant", "page(preview)", "work(read)", "assistant"]);
});

test("调用 preview 之后接着想、这条回复就此结束：页面也不收进过程", () => {
	const reply = { ...mixed("think:先想想", "preview", "think:好了"), stopReason: "stop" } as Message;
	const messages = [user("画一只小狗"), reply, result(reply, 1)];
	const blocks = turnBlocks(runs(messages));
	assert.deepEqual(describe(blocks), ["user", "assistant", "page(preview)", "assistant"]);
	// 回复自己的那一行（时间、交付卡片挂在它下面）还是最后那一段，不是被拆到前面的推理。
	const last = blocks.at(-1)!.runs.at(-1)!;
	assert.ok(last.kind === "message" && !last.lead && last.from === 2 && last.upTo === 3);
});

test("页面前面说过的话还是一句话：算过程里的一行，但不当成推理并进别的行", () => {
	const reply = mixed("say:我先画一版。", "preview", "think:看看效果", "read");
	const messages = [user("画一只小狗"), reply, result(reply, 1), result(reply, 3), answer("画好了。")];
	assert.deepEqual(describe(turnBlocks(runs(messages))), ["user", "assistant", "page(preview)", "work(read)", "assistant"]);
});

test("回复里的页面接着写下去时，它那一行的身份不变，页面不会重新挂一遍", () => {
	const writing = { ...mixed("think:先想想", "preview"), stopReason: "pending" } as Message;
	const before = runs([user("画一只小狗"), writing]);
	const after = runs([user("画一只小狗"), { ...writing, content: [...writing.content, { type: "thinking", thinking: "再看看" }] } as Message]);
	const page = (rows: Run[]) => rows.filter((row) => row.kind === "tools" && row.shown).map(runKey);
	assert.equal(page(before).length, 1);
	assert.deepEqual(page(after), page(before));
});
