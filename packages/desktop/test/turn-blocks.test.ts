/**
 * 一整轮里，哪些跟着锚收起来，哪一句是回答；哪些调用合成一行。
 *
 * 「想 → 做 → 说」这条线是在 Run 这一层定下来的，不是在渲染时看邻居。规则性的东西要能单独测——
 * 而这一条尤其容易悄悄错：判错了边界，收起过程时会把答案一起收进去，或者把过程漏在外面，
 * 两种都不报错，只是屏幕上不对。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "@plume/core";

import { turnBlocks, turnEnd, withoutThinking, type Run, type TurnBlock } from "../src/features/conversation/grouping.ts";

const ask = (text: string, index: number): Run => ({
	kind: "message",
	message: { role: "user", content: [{ type: "text", text }], timestamp: 1 } as Message,
	index,
	upTo: 1,
});

/** 被单独拆出来的开头推理行——`leadingThinking` 干的事。 */
const think = (index: number): Run => ({
	kind: "message",
	message: { role: "assistant", content: [{ type: "thinking", thinking: "想想" }], stopReason: "toolUse" } as Message,
	index,
	upTo: 1,
	lead: true,
});

/** 一条只想了、然后只调了工具的回复：它没有正文行可以「领」，所以不带 `lead`。 */
const thinkingOnly = (index: number): Run => ({
	kind: "message",
	message: { role: "assistant", content: [{ type: "thinking", thinking: "再想想" }, { type: "toolCall", id: "t", name: "read", arguments: {} }], stopReason: "toolUse" } as Message,
	index,
	upTo: 1,
});

const say = (text: string, index: number): Run => ({
	kind: "message",
	message: { role: "assistant", content: [{ type: "text", text }], stopReason: "end" } as Message,
	index,
	upTo: 1,
});

let id = 0;
/** 一段活：默认读文件，也可以点名是哪几个工具。 */
const work = (n: number | string[]): Run => ({
	kind: "tools",
	calls: (typeof n === "number" ? Array.from({ length: n }, () => "read") : n).map((name) => ({
		block: { type: "toolCall", id: `c${id++}`, name, arguments: {} },
		stopReason: "toolUse",
	})) as Run extends { kind: "tools"; calls: infer C } ? C : never,
});

const shape = (list: Run[]) => turnBlocks(list).map((b) => b.kind);

/** 锚下面的每一行：`step(n)` 是合成一行的 n 次调用，`~` 是跟着锚收起来的。 */
const items = (block: TurnBlock) =>
	block.items.map((item) =>
		item.kind === "step" ? `step(${item.step.members.map((m) => (m.kind === "call" ? m.call.block.name : "think")).join(",")})` : `${item.fold ? "~" : ""}${item.run.kind === "message" ? item.run.message.role : item.run.kind}`,
	);

test("一轮有过程：一块，过程跟着锚收，最后那句话是回答", () => {
	const blocks = turnBlocks([ask("帮我看看", 0), think(1), work(2), think(3), work(1), say("看完了。", 5)]);
	assert.deepEqual(shape([ask("帮我看看", 0), think(1), work(2), think(3), work(1), say("看完了。", 5)]), ["plain", "work"]);
	assert.deepEqual(items(blocks[1]), ["step(think,read,read,think,read)", "assistant"], "开头的推理跟着第一次调用开一段，后面的推理算进它所在的那一段");
	assert.equal(blocks[1].runs.length, 5, "开口那句话之外的全在这一块");
});

test("同一类连着做的合成一行，换了一类另起一行", () => {
	const blocks = turnBlocks([ask("改一下", 0), work(["read", "grep"]), work(["edit"]), think(3), work(["write", "bash"]), say("好了。", 5)]);
	assert.deepEqual(items(blocks[1]), ["step(read,grep)", "step(edit,think,write)", "step(bash)", "assistant"]);
	const keys = blocks[1].items.filter((item) => item.kind === "step").map((item) => item.key);
	assert.equal(new Set(keys).size, keys.length, "每一段一个 key");
});

test("浏览器的几个工具是同一类", () => {
	const blocks = turnBlocks([ask("点一遍", 0), work(["browser_open"]), think(2), work(["browser_act"]), work(["browser_screenshot"])]);
	assert.deepEqual(items(blocks[1]), ["step(browser_open,think,browser_act,browser_screenshot)"]);
});

test("一段活往后长，它的 key 不变", () => {
	// 换 key 等于卸掉重建：跑着的那一行会在原地闪一下，点开着的会合上。
	const first = work(["browser_open"]);
	const before = turnBlocks([ask("点一遍", 0), first]);
	const after = turnBlocks([ask("点一遍", 0), first, think(2), work(["browser_act"])]);
	assert.equal(before[1].items[0].key, after[1].items[0].key);
});

test("中途说的话把一段活切开，跟着过程一起收；只有最后那句在外面", () => {
	const blocks = turnBlocks([ask("改一下", 0), work(1), say("我先看一下配置。", 2), work(1), say("改好了。", 4)]);
	assert.deepEqual(shape([ask("改一下", 0), work(1), say("我先看一下配置。", 2), work(1), say("改好了。", 4)]), ["plain", "work"]);
	assert.deepEqual(items(blocks[1]), ["step(read)", "~assistant", "step(read)", "assistant"]);
});

test("说完一句又接着想：推理不挂到话前面那段活上", () => {
	const blocks = turnBlocks([ask("改一下", 0), work(1), say("我先看一下配置。", 2), thinkingOnly(3), work(2)]);
	assert.deepEqual(items(blocks[1]), ["step(read)", "~assistant", "step(think,read,read)"]);
});

test("还没说出最后那句话时，全在锚下面", () => {
	const blocks = turnBlocks([ask("跑一下", 0), think(1), work(2)]);
	assert.deepEqual(items(blocks[1]), ["step(think,read,read)"]);
});

test("只有重连标记、没有推理和工具的一轮不要锚", () => {
	const hiccup = { kind: "hiccup", hiccup: {} } as Run;
	assert.deepEqual(shape([ask("跑一下", 0), say("先说一句。", 1), hiccup, say("接着说。", 2)]), ["plain", "plain", "plain", "plain"]);
});

test("断线还在等、或者已经放弃时，留在外面；收了场才算过程", () => {
	const drop = (outcome: string) => ({ kind: "hiccup", hiccup: { outcome } }) as unknown as Run;
	assert.deepEqual(items(turnBlocks([ask("跑一下", 0), work(1), drop("waiting")])[1]), ["step(read)", "hiccup"], "等重试的倒计时要看得见");
	assert.deepEqual(items(turnBlocks([ask("跑一下", 0), work(1), drop("gave_up")])[1]), ["step(read)", "hiccup"], "放弃了的那条带着「继续」");
	assert.deepEqual(items(turnBlocks([ask("跑一下", 0), work(1), drop("recovered"), work(2)])[1]), ["step(read)", "~hiccup", "step(read,read)"], "救回来的断线是这段活里的一件事");
});

test("一条什么都没说出来的失败回复不收进锚里", () => {
	const failed: Run = { kind: "message", message: { role: "assistant", content: [], stopReason: "error" } as Message, index: 2, upTo: 0 };
	assert.deepEqual(items(turnBlocks([ask("跑一下", 0), work(1), failed])[1]), ["step(read)", "assistant"], "失败那一行是它唯一露面的机会");
});

test("没有过程的一轮不产生空壳", () => {
	// 一问一答，中间什么都没发生——不该凭空多出一行「已工作」。
	assert.deepEqual(shape([ask("你好", 0), say("你好。", 1)]), ["plain", "plain"]);
});

test("挂在一段活后面的推理就是那一段的，换了一类也不跟过去", () => {
	// 跟过去的话，上一行的「思考 N 次」会少一次，数往回跳。
	const blocks = turnBlocks([ask("跑一下", 0), work(["read"]), think(2), work(["bash"])]);
	assert.deepEqual(items(blocks[1]), ["step(read,think)", "step(bash)"]);
});

/** 一次 bash：分到哪一类看命令本身。 */
const shell = (command: string): Run => ({
	kind: "tools",
	calls: [{ block: { type: "toolCall", id: `c${id++}`, name: "bash", arguments: { command } }, stopReason: "toolUse" }],
} as Run);

test("只读的 shell 命令和读、搜是同一段探索，跑别的命令另起一行", () => {
	const blocks = turnBlocks([ask("查一下", 0), work(["read"]), shell("rg -n 'a|b' src | head -20"), work(["grep"]), shell("pnpm test | tail -5")]);
	assert.deepEqual(items(blocks[1]), ["step(read,bash,grep)", "step(bash)"]);
});

test("关掉的那一类每次调用自成一行，开关管不着的几类照旧合", () => {
	const list = [ask("改一下", 0), work(["read", "grep"]), work(["edit", "write"]), shell("pnpm build"), shell("pnpm test"), work(["browser_open", "browser_act"])];
	const off = { groupExplore: false, groupTerminal: false, groupChanges: false };
	assert.deepEqual(items(turnBlocks(list, off)[1]), ["step(read)", "step(grep)", "step(edit)", "step(write)", "step(bash)", "step(bash)", "step(browser_open,browser_act)"]);
	assert.deepEqual(
		items(turnBlocks(list, { groupExplore: true, groupTerminal: true, groupChanges: false })[1]),
		["step(read,grep)", "step(edit)", "step(write)", "step(bash,bash)", "step(browser_open,browser_act)"],
		"默认：文件更改一处一行",
	);
	const keys = turnBlocks(list, off)[1].items.map((item) => item.key);
	assert.equal(new Set(keys).size, keys.length, "拆开的每一行各有自己的 key");
});

test("只想不做的一轮，锚下面只有那段推理", () => {
	const blocks = turnBlocks([ask("想想这个", 0), think(1), say("我的看法是……", 2)]);
	assert.deepEqual(items(blocks[1]), ["~assistant", "assistant"]);
});

test("连着两轮各自成块，不会串到一起", () => {
	const blocks = turnBlocks([
		ask("第一件事", 0), think(1), work(1), say("好了。", 3),
		ask("第二件事", 4), think(5), work(2), say("也好了。", 8),
	]);
	assert.deepEqual(blocks.map((b) => b.kind), ["plain", "work", "plain", "work"]);
	assert.notEqual(blocks[1].turn, blocks[3].turn, "两轮各归各的，否则旧的那段会跟着新的一起摊开");
});

/** 后台结果送回来、把会话叫醒的那条消息；`peer` 时是另一个会话的来信，也一起送到。 */
const delivered = (index: number, peer = false): Run => ({
	kind: "message",
	message: {
		role: "user",
		content: [{ type: "text", text: "<report>" }],
		synthetic: true,
		delivery: [{ id: `d${index}`, agent: "general", description: "长任务", status: "done" }],
		...(peer ? { peer: [{ from: "别的会话", text: "看一下" }] } : {}),
		timestamp: 1,
	} as Message,
	index,
	upTo: 1,
});

test("送达叫醒的一轮不要锚，人开的那一轮照旧有", () => {
	const blocks = turnBlocks([ask("派两个出去", 0), think(1), say("派出去了。", 2), delivered(3), think(4), work(1), say("B 回来了。", 6)]);
	assert.deepEqual(blocks.map((b) => [b.kind, b.woken ?? false]), [["plain", false], ["work", false], ["plain", false], ["work", true]]);
});

test("和来信一起到的送达，回它的那一轮照旧有锚", () => {
	const blocks = turnBlocks([delivered(0, true), think(1), say("看了。", 2)]);
	assert.equal(blocks[1].woken, undefined);
});

test("不显示推理时，推理行拿掉；被它隔开的同类活合成一行", () => {
	const blocks = turnBlocks(withoutThinking([ask("看看", 0), think(1), work(1), thinkingOnly(2), work(1), say("看完了。", 3)]));
	assert.deepEqual(blocks.map((b) => b.kind), ["plain", "work"]);
	assert.deepEqual(items(blocks[1]), ["step(read,read)", "assistant"]);
});

test("不显示推理时，只想不做的一轮没有锚，就是一句回答", () => {
	assert.deepEqual(shape(withoutThinking([ask("在吗", 0), think(1), say("在。", 1)])), ["plain", "plain"]);
});

test("不显示推理时，停在推理上的那一行留个壳：推理切掉，行还在", () => {
	const stopped: Run = {
		kind: "message",
		message: { role: "assistant", content: [{ type: "thinking", thinking: "想到一半" }], stopReason: "aborted" } as Message,
		index: 1,
		upTo: 1,
	};
	const kept = withoutThinking([ask("改一下", 0), stopped]);
	assert.equal(kept.length, 2);
	assert.deepEqual(kept[1].kind === "message" && [kept[1].from, kept[1].upTo], [1, 1]);
	assert.deepEqual(shape(kept), ["plain", "plain"], "空壳不算推理，不该长出锚");
});

test("turnEnd 是下一句人话的前一条，没有下一句就是末尾", () => {
	const blocks = turnBlocks([ask("第一件", 0), work(1), say("好了。", 3), ask("第二件", 5), work(1)]);
	assert.equal(turnEnd(blocks, 1, 8), 4);
	assert.equal(turnEnd(blocks, 3, 8), 7);
});

/*
 * 一轮里塞进几百个 Run，它们收成**一个**块——这就是「显示更早」曾经点了没反应的成因。
 *
 * 转录的分页窗口从前按 Run 走（那是当时唯一控得住渲染量的闸门），而画出来的单位是块。真实会话里
 * 用户两次发言之间跑过 400 次工具调用，于是往前翻 60 个 Run 时，那 60 个全落进一个已经收起的
 * 块——屏幕上唯一的变化是那行数字。连点四次，转录一动不动（2026-09-15 的录屏）。
 *
 * 窗口现在按块走（`Conversation.tsx` 的 `allBlocks`），所以翻一次必然多出整块、必然看得见。这条
 * 测试钉的是那个成因本身：只要一轮还能收成一个块，按 Run 分页就一定会退化，谁想改回去都得先过它。
 */
test("hundreds of runs between two questions still collapse into a single block", () => {
	const long: Run[] = [ask("查一下这个问题", 0)];
	for (let i = 0; i < 200; i++) {
		long.push(think(i * 2 + 1), work(2));
	}
	long.push(ask("那彻底修一下", 401));

	const blocks = turnBlocks(long);
	const work_ = blocks.filter((block) => block.kind === "work");

	assert.equal(work_.length, 1, "两次发言之间的一切收成一块——这正是按 Run 翻页会失效的原因");
	assert.ok(work_[0].runs.length > 300, `那一块里装着 ${work_[0].runs.length} 个 Run`);
	assert.equal(work_[0].items.length, 1, "同一类的活连同推理合成一行");
	assert.ok(blocks.length >= 3, "开头的问题、中间的一轮、末尾的问题，至少三块");
});

/*
 * 窗口切的是块，不是 Run——这个决定写在组件里，没有可以单独调用的函数，所以只能对着源码钉。
 *
 * 换个写法就退回原样了，而且退回去之后没有任何测试会红：`turnBlocks` 照常工作、`slice` 照常工作，
 * 只有屏幕上不对。那正是这个 bug 活到今天的方式。
 */
test("the transcript window pages by block, not by run", async () => {
	const { readFile } = await import("node:fs/promises");
	const source = await readFile(new URL("../src/features/conversation/Conversation.tsx", import.meta.url), "utf8");

	assert.match(source, /useTranscriptWindow\([^)]*allBlocks\.length\)/, "窗口的总数要按块算");
	assert.match(source, /allBlocks\.slice\(range\.start, range\.end\)/, "切的要是块");
	assert.ok(!/allRuns\.slice\(range/.test(source), "切 Run 就是那个「点了没反应」的写法");
	assert.match(source, /turnBlocks\(allRuns[,)]/, "要先分块再开窗，顺序反过来等于没改");
});
