/**
 * 有过程的一轮，和里面那一段段活。
 *
 * 第一条盯的是一轮怎么摊开：没有整轮的锚和折叠，行按顺序排、不重挂。后几条盯的是一段活怎么说话，以及
 * 收着的一段活里面的调用真的不在 DOM 里——一轮四百次调用，只要它们还挂着，代价就一个不少。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as h } from "react";
import type { AssistantContent, Message, Settings } from "@plume/core";
import { LiveToolCard, ToolRun } from "../../src/features/conversation/runs.tsx";
import { TurnWork } from "../../src/features/conversation/TurnWork.tsx";
import { WorkStep, type DrawCall } from "../../src/features/conversation/WorkStep.tsx";
import type { Call, Run, Step } from "../../src/features/conversation/grouping.ts";
import { useApp } from "../../src/store/index.ts";
import { HOLD_MS } from "../../src/ui/motion/held.ts";
import { click, mount } from "../helpers/mount.ts";

const inside = h("div", { "data-probe": "inside" }, "四百条过程");
const answer = h("div", { "data-probe": "answer" }, "做好了。");
const ENTRIES = [
	{ key: "process", node: inside },
	{ key: "answer", node: answer },
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

/** 改几条调用记录的状态，就像它们开跑或跑完。 */
const status = (next: Record<string, "running" | "done">) =>
	act(async () => {
		const runs = useApp.getState().toolRuns;
		useApp.setState({ toolRuns: { ...runs, ...Object.fromEntries(Object.entries(next).map(([id, value]) => [id, { ...runs[id], status: value }])) } });
	});

/** 等过一段停留时长，连同到点时那一次换。 */
const wait = (ms: number) => act(() => new Promise<void>((done) => setTimeout(done, ms + 50)));

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

test("a turn with work draws every line in order, with no anchor and nothing folded", async () => {
	const view = await mount(h(TurnWork, { entries: ENTRIES }));
	try {
		assert.equal(view.all(".ly-turn-anchor, button[aria-expanded]").length, 0, "没有整轮的锚，也没有整轮折叠");
		assert.equal(view.all('[data-probe="inside"]').length, 1, "过程摊在对话里");
		assert.equal(view.all('[data-probe="answer"]').length, 1, "回答跟在最后");
		const said = view.find('[data-probe="answer"]');
		await view.rerender(h(TurnWork, { entries: [{ key: "later", node: h("div", null, "后来又做的") }, ...ENTRIES] }));
		assert.equal(view.find('[data-probe="answer"]'), said, "前面多出一行，原来那几行不重挂");
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

test("while it runs the line says the call that is running, holds each for a moment, then rolls to the total", async () => {
	const calls = [browse("b1", "browser_open", { url: "todo.html" }), browse("b2", "browser_screenshot")];
	const more = [...calls, browse("b3", "browser_act")];
	const restore = withRuns(more);
	await status({ b1: "running" });
	const view = await mount(h(WorkStep, { step: step(calls), live: true, draw: () => null, drawCall }));
	try {
		const words = view.find(".ly-roll-words");
		assert.equal(words.textContent, "打开网页 todo.html", "说的是还在跑的那一次，不是最后发出的那次");
		assert.ok(words.querySelector(".ly-glide"), "正在跑的那一行在扫光，光挂在字上");

		const said = words.firstElementChild;
		await status({ b1: "done", b3: "running" });
		await view.rerender(h(WorkStep, { step: step(more), live: true, draw: () => null, drawCall }));
		assert.equal(words.textContent, "打开网页 todo.html", "上一句还没挂满，先不换");
		await wait(HOLD_MS);
		assert.equal(view.find(".ly-roll-words"), words, "还是同一个框，宽度从旧的缓过去");
		assert.equal(words.textContent, "操作网页", "挂满了，换成正在跑的那一次");
		assert.notEqual(words.firstElementChild, said, "换了一句话：新的一层滚进来");
		assert.ok(words.firstElementChild?.classList.contains("ly-roll-soft"));

		await status({ b3: "done" });
		await view.rerender(h(WorkStep, { step: step(more), live: false, draw: () => null, drawCall }));
		assert.equal(words.textContent, "操作网页", "换成总的也要等这一句挂满");
		await wait(HOLD_MS);
		assert.equal(words.textContent, "打开网页 todo.html、截取网页、操作网页", "不再长了，滚成总的");
		assert.ok(words.firstElementChild?.classList.contains("ly-roll-soft"), "换成总的也是滚过去，不是硬换");
		assert.equal(words.querySelector(".ly-glide"), null, "停下的那一行不再扫光");
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
		assert.equal(view.find(".ly-roll-words").textContent, "打开网页 todo.html", "跑着时说的还是那一次调用，推理的次数等停下再算进去");
		assert.match(view.text(), /正在思考/, "还在写的那段在句尾说一声");
	} finally {
		await view.unmount();
		restore();
	}
});

test("one call says the model's own words when it gave some", async () => {
	const tool = (id: string, name: string, args: Record<string, unknown>): Call => ({ block: { type: "toolCall", id, name, arguments: args }, stopReason: "toolUse" });
	const calls = [
		tool("d1", "read", { path: "docs/safety.md", description: "看审批规则怎么写" }),
		tool("d2", "read", { path: "docs/safety.md" }),
		// 没给 pattern：description 里是模型错放的式子，core 拿它当 pattern 搜，这里不当一句话说。
		tool("d3", "grep", { description: "timeout|overtime" }),
	];
	const restore = withRuns(calls);
	// 一个一个挂：`act` 叠在一起时，后面几条测试拿到的是没提交完的树。
	const rows = [];
	for (const call of calls) rows.push(await mount(drawCall(call)));
	try {
		assert.match(rows[0].text(), /^看审批规则怎么写/);
		assert.match(rows[1].text(), /^读取文件 safety\.md/, "没写就照旧");
		assert.match(rows[2].text(), /^搜索内容/);
	} finally {
		for (const row of rows) await row.unmount();
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
