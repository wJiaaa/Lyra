/**
 * 一轮的锚，和锚下面那一段段活。
 *
 * 收起的一轮是转录里最贵的东西：一轮四百次工具调用收在一行「已工作 12 分 3 秒」底下，看上去什么都
 * 没有，而只要那些行还挂在 DOM 里，代价就一个不少——只是高度被压成了 0。量不出来是因为它们不可见，
 * 不是因为它们不存在。所以前几条盯的是「收起来的东西真的不在了」，后几条盯的是一段活怎么说话。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h } from "react";
import type { AssistantContent, Message, Settings } from "@plume/core";
import { LiveToolCard, ToolRun } from "../../src/features/conversation/runs.tsx";
import { TurnWork } from "../../src/features/conversation/TurnWork.tsx";
import { WorkStep, type DrawCall } from "../../src/features/conversation/WorkStep.tsx";
import type { Call, Run, Step } from "../../src/features/conversation/grouping.ts";
import { useApp } from "../../src/store/index.ts";
import { click, fire, mount } from "../helpers/mount.ts";

const inside = h("div", { "data-probe": "inside" }, "四百条过程");
const answer = h("div", { "data-probe": "answer" }, "做好了。");
const ENTRIES = [
	{ key: "process", fold: true, node: inside },
	{ key: "answer", fold: false, node: answer },
];

type ToolCall = Extract<AssistantContent, { type: "toolCall" }>;
const read = (id: string, path: string): ToolCall => ({ type: "toolCall", id, name: "read", arguments: { path } });
const browse = (id: string, name: string, args: Record<string, unknown> = {}): Call => ({ block: { type: "toolCall", id, name, arguments: args }, stopReason: "toolUse" });

/** 把调用的记录放进 store，就像它们真的跑过。 */
function withRuns(calls: Call[], status: "running" | "done" = "done") {
	const previous = useApp.getState();
	useApp.setState({
		activeSessionId: "s",
		capabilities: null,
		settings: { appearance: {} } as Settings,
		toolRuns: Object.fromEntries(calls.map(({ block }) => [block.id, { toolCallId: block.id, toolName: block.name, summary: block.name, args: block.arguments, status, startedAt: Date.now() - 1000 }])),
	});
	return () => useApp.setState(previous, true);
}

/** 和 `Conversation` 递进去的是同一个。 */
const drawCall: DrawCall = ({ block, stopReason }, line) => h(LiveToolCard, { block, stopReason, ...line });

/** 一段推理；`writing` 的还在写。 */
const thought = (writing: boolean) =>
	({
		kind: "message",
		message: { role: "assistant", content: [{ type: "thinking", thinking: "页面出来了", startedAt: Date.now() }], stopReason: writing ? "pending" : "toolUse", timestamp: 1 } as Message,
		index: 3,
		upTo: 1,
	}) as Extract<Run, { kind: "message" }>;

const step = (calls: Call[], extra: Step["members"] = []): Step => ({
	key: `step-${calls[0].block.id}`,
	category: "browser",
	calls,
	members: [...calls.map((call) => ({ kind: "call" as const, call })), ...extra],
});

test("a finished turn stays open line by line; folding it releases what is folded and keeps the answer out", async () => {
	const view = await mount(h(TurnWork, { running: false, durationMs: 101_000, entries: ENTRIES }));
	try {
		const toggle = view.find<HTMLButtonElement>("button[aria-expanded]");
		assert.equal(toggle.getAttribute("aria-expanded"), "true", "跑完不自动收：一段段活各自一行摊着");
		assert.equal(view.all('[data-probe="inside"]').length, 1);
		assert.match(view.text(), /已工作 1 分 41 秒/, "锚说这一轮跑了多久");

		await click(toggle);
		assert.equal(toggle.getAttribute("aria-expanded"), "false", "想收的人点锚");
		const event = new Event("transitionend", { bubbles: true });
		Object.defineProperty(event, "propertyName", { value: "grid-template-rows" });
		await fire(view.find('.ly-freeze[data-open="false"]'), event);
		assert.equal(view.all('[data-probe="inside"]').length, 0, "收完的东西不留在 DOM 里");
		assert.equal(view.all('[data-probe="answer"]').length, 1, "回答永远在外面");
		const box = view.find('.ly-freeze[data-open="false"]');
		assert.ok(box.hasAttribute("inert"), "收起的不在 tab 顺序里");
		assert.equal(box.getAttribute("aria-hidden"), "true");
	} finally {
		await view.unmount();
	}
});

test("while the turn runs the anchor says so and cannot fold; once it ends it is still the same open element", async () => {
	const view = await mount(h(TurnWork, { running: true, entries: ENTRIES }));
	try {
		const anchor = view.find<HTMLButtonElement>(".ly-turn-anchor");
		assert.ok(anchor.disabled, "跑的时候锚不能点");
		assert.match(anchor.textContent ?? "", /工作中/);
		assert.equal(view.all('[data-probe="inside"]').length, 1, "里面的东西全摊着");

		await view.rerender(h(TurnWork, { running: false, durationMs: 9_000, entries: ENTRIES }));
		assert.equal(view.find(".ly-turn-anchor"), anchor, "跑完还是同一个元素：换元素那一刻锚会闪一下");
		assert.equal(anchor.getAttribute("aria-expanded"), "true", "跑完不收");
		assert.equal(view.all('[data-probe="inside"]').length, 1);
		assert.match(anchor.textContent ?? "", /已工作 9 秒/);
	} finally {
		await view.unmount();
	}
});

test("several calls of one kind are one line saying what they did, with the calls inside", async () => {
	const calls = [browse("b1", "browser_open", { url: "http://localhost:5173/todo.html" }), browse("b2", "browser_act"), browse("b3", "browser_act"), browse("b4", "browser_screenshot")];
	const restore = withRuns(calls);
	const view = await mount(h(WorkStep, { step: step(calls), live: false, draw: () => null, drawCall }));
	try {
		const row = view.find<HTMLButtonElement>("button[aria-expanded]");
		assert.match(row.textContent ?? "", /^打开网页 todo\.html、操作网页 2 次、截取网页/, "做完说总的，用人话，前面不再挂「浏览器 ·」");
		assert.equal(view.all("[data-ly-tool]").length, 0, "收着的时候里面的调用不在 DOM 里");

		await click(row);
		assert.equal(view.all("[data-ly-step-rail] [data-ly-tool]").length, 4, "点开是挂在竖线上的每一次调用");
	} finally {
		await view.unmount();
		restore();
	}
});

test("while it runs the line already says the total, and a new call lands at its end", async () => {
	const calls = [browse("b1", "browser_open", { url: "todo.html" }), browse("b2", "browser_screenshot")];
	const restore = withRuns([...calls, browse("b3", "browser_act")], "running");
	const view = await mount(h(WorkStep, { step: step(calls), live: true, draw: () => null, drawCall }));
	try {
		const words = view.find(".ly-roll-words");
		const before = words.textContent ?? "";
		assert.equal(before, "打开网页 todo.html、截取网页", "跑着也说总的，不换成最新那一步");
		assert.ok(words.querySelector(".ly-glide"), "正在跑的那一行在扫光，光挂在字上");

		await view.rerender(h(WorkStep, { step: step([...calls, browse("b3", "browser_act")]), live: true, draw: () => null, drawCall }));
		assert.equal(view.find(".ly-roll-words"), words, "还是同一个框：句子往后长，不重新滚一遍");
		assert.ok((words.textContent ?? "").startsWith(before), "前面的字不动");
		assert.match(words.textContent ?? "", /操作网页$/, "新的一次接在句尾");
	} finally {
		await view.unmount();
		restore();
	}
});

test("thinking before the calls is counted at the front of the line", async () => {
	const calls = [browse("b1", "browser_open", { url: "todo.html" }), browse("b2", "browser_screenshot")];
	const restore = withRuns(calls);
	const view = await mount(h(WorkStep, { step: { ...step(calls), members: [{ kind: "thinking", run: thought(false) }, ...step(calls).members] }, live: false, draw: () => null, drawCall }));
	try {
		assert.equal(view.find(".ly-roll-words").textContent, "思考 1 次 · 打开网页 todo.html、截取网页");
	} finally {
		await view.unmount();
		restore();
	}
});

test("thinking still being written at the end of a stretch is said at the end of that line", async () => {
	// 另一个 id：同一会话里点开过的行会被记住，前面那条点开过 `step-b1`。
	const calls = [browse("t1", "browser_open", { url: "todo.html" })];
	const restore = withRuns(calls);
	const view = await mount(h(WorkStep, { step: step(calls, [{ kind: "thinking", run: thought(true) }]), live: true, draw: () => h("div", { "data-probe": "thought" }), drawCall }));
	try {
		assert.equal(view.all(".ly-flow-row").length, 1, "推理不另起一行");
		assert.equal(view.find(".ly-roll-words").textContent, "打开网页 todo.html · 思考 1 次", "先有的那半句不动，推理的次数接在后面");
		assert.match(view.text(), /正在思考/, "还在写的那段在句尾说一声");
	} finally {
		await view.unmount();
		restore();
	}
});

test("one call is the call's own row", async () => {
	const calls = [browse("b1", "browser_open", { url: "https://example.com/" })];
	const restore = withRuns(calls);
	const view = await mount(h(WorkStep, { step: step(calls), live: false, draw: () => null, drawCall }));
	try {
		assert.equal(view.all("[data-ly-tool]").length, 1);
		assert.match(view.text(), /打开网页 example\.com/, "没写 summarize 的工具不再露出 browser_open 这种名字");
	} finally {
		await view.unmount();
		restore();
	}
});

test("panels without an anchor still draw each call as a row of its own when asked to", async () => {
	const previous = useApp.getState();
	const calls = [read("r1", "src/a.ts"), read("r2", "src/b.ts")];
	useApp.setState({
		activeSessionId: "flat",
		capabilities: null,
		settings: { appearance: {} } as Settings,
		toolRuns: Object.fromEntries(calls.map((call) => [call.id, { toolCallId: call.id, toolName: "read", summary: `Read ${String(call.arguments.path)}`, args: call.arguments, status: "done" as const, startedAt: Date.now() - 1000 }])),
	});
	const view = await mount(h(ToolRun, { calls: calls.map((block) => ({ block, stopReason: "toolUse" as const })), flat: true }));
	try {
		assert.equal(view.all("[data-ly-run] > button").length, 0, "no group line over them");
		const rows = view.all<HTMLElement>("[data-ly-tool]");
		assert.equal(rows.length, 2, "one row per call");
		assert.match(rows[0].textContent ?? "", /读取文件 a\.ts/, "core's English summary is not what the row says");
	} finally {
		await view.unmount();
		useApp.setState(previous, true);
	}
});
