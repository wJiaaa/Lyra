/**
 * 会话进行到一半时换模型。
 *
 * 这条路径上有两个浮层，各自管着自己的退场动画，而它们的时长曾经决定过功能成不成立：
 * 菜单（`Popover`）在被点到外面时 120ms 后卸载自己，确认框（`Overlay`）在按下确认后
 * 130ms 播完退场动画才回调。确认框是画在菜单里的——它一被菜单带着卸载，那个 `animationend`
 * 就永远不会来，`setModel` 一次也没被调用过。屏幕上是「确认切换」按下去、弹窗消失、模型没变。
 *
 * 所以这里断言的不是动画，是两件在真实点击顺序下必须成立的事：
 *
 *   1. 按下确认框上的按钮，不算「点在菜单外面」——菜单不能因此把自己连同确认框一起收走；
 *   2. 就算它真被收走了，已经答应过的那次确认也必须照办。
 *
 * 第二条是兜底，也是唯一能挡住下一次「谁把 120 改成 200」的东西。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h } from "react";
import { DEFAULT_SETTINGS, type Settings } from "@lyra/core";

import { ModelMenu } from "../../src/features/models/ModelMenu.tsx";
import { Confirm } from "../../src/ui/overlay/Confirm.tsx";
import { useApp } from "../../src/store/index.ts";
import { fire, mount } from "../helpers/mount.ts";

const models = Array.from({ length: 3 }, (_, i) => ({
	id: `qa/${i}`,
	modelId: `model-${i}`,
	providerId: "qa",
	name: `Model ${i}`,
	supportsThinking: true,
	supportsImages: false,
	supportsTools: true,
	contextWindow: 128_000,
	maxOutputTokens: 8192,
}));

const settings: Settings = {
	...DEFAULT_SETTINGS,
	providers: [{ id: "qa", name: "QA", api: "openai-responses", apiKey: "test", baseUrl: "http://localhost", enabled: true, models }],
	defaultModelId: "qa/0",
};

const meta = {
	id: "s1",
	title: "会话",
	cwd: "/tmp",
	projectId: "p",
	projectName: "P",
	createdAt: 1,
	updatedAt: 1,
	modelId: "qa/0",
	messageCount: 1,
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
} as never;

/** 一次真实的按下：capture 阶段的 mousedown 先到，click 后到。 */
async function pressButton(element: Element): Promise<void> {
	await fire(element, new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
	await fire(element, new MouseEvent("click", { bubbles: true, cancelable: true }));
}

/**
 * 确认框退场动画播完的那一帧。
 *
 * `Overlay` 把回调挂在 `animationend` 上，而 happy-dom 没有合成器——不补这一下，测试里的
 * 「按下确认」就永远停在动画中间，跟真机上的行为对不上。
 */
async function finishExitAnimation(): Promise<void> {
	const card = document.querySelector("[data-ly-modal]");
	if (card) await fire(card, new Event("animationend", { bubbles: true }));
}

function withSession(overrides: Record<string, unknown> = {}) {
	const previous = { setModel: useApp.getState().setModel, notify: useApp.getState().notify };
	useApp.setState({
		settings,
		meta,
		activeSessionId: "s1",
		messages: [{ role: "user", timestamp: 1, content: [{ type: "text", text: "已经聊过了" }] }],
		...overrides,
	});
	return () => useApp.setState(previous);
}

test("会话中途确认切换，模型真的换掉", async () => {
	const picked: string[] = [];
	const restore = withSession({ setModel: async (id: string) => { picked.push(id); } });

	const anchor = document.createElement("button");
	document.body.append(anchor);
	const view = await mount(h(ModelMenu, { anchor, onClose: () => {} }));

	try {
		const row = document.querySelector('[data-model="qa/1"] button');
		assert.ok(row, "菜单里应该有 qa/1 这一行");
		await pressButton(row);

		const dialog = document.querySelector("[data-ly-modal]");
		assert.ok(dialog, "中途换模型要先问一句");
		assert.match(dialog.textContent ?? "", /确定要中途切换模型吗？/);

		const confirm = [...dialog.querySelectorAll("button")].find((each) => (each.getAttribute("aria-label") ?? each.textContent) === "确认切换");
		assert.ok(confirm, "确认框上应该有「确认切换」");

		// 完整回放：按下、菜单那 120ms 的卸载定时器跑完、确认框的退场动画播完。
		await pressButton(confirm);
		await new Promise((resolve) => setTimeout(resolve, 200));
		await finishExitAnimation();

		assert.deepEqual(picked, ["qa/1"], "确认过的切换必须真的发生");
	} finally {
		await view.unmount();
		anchor.remove();
		restore();
	}
});

test("菜单在退场动画播完前就消失，确认过的切换照样发生", async () => {
	/*
	 * 这条盯的就是用户录屏里那一幕。
	 *
	 * 菜单 120ms 后卸载自己，确认框的退场动画要 130ms——中间那 10ms 里，确认框被菜单带走，
	 * `animationend` 再也不会来，`setModel` 一次都没被调用过。屏幕上是按钮按下去、弹窗消失、
	 * 模型没变，而且什么都没说。
	 *
	 * 这里不 dispatch `animationend`，直接卸载，就是那一幕：答应过的事必须已经落地。
	 */
	const picked: string[] = [];
	const restore = withSession({ setModel: async (id: string) => { picked.push(id); } });

	const anchor = document.createElement("button");
	document.body.append(anchor);
	const view = await mount(h(ModelMenu, { anchor, onClose: () => {} }));

	try {
		await pressButton(document.querySelector('[data-model="qa/1"] button')!);
		const confirm = [...document.querySelectorAll("[data-ly-modal] button")].find((each) => (each.getAttribute("aria-label") ?? each.textContent) === "确认切换");
		assert.ok(confirm);
		await pressButton(confirm);
		assert.deepEqual(picked, [], "动画还在播的时候还没轮到它");

		await view.unmount();
		assert.deepEqual(picked, ["qa/1"], "卸载不是反悔");
	} finally {
		anchor.remove();
		restore();
	}
});

test("按在确认框上不算点在菜单外面", async () => {
	const restore = withSession({ setModel: async () => {} });

	const anchor = document.createElement("button");
	document.body.append(anchor);
	let closed = false;
	const view = await mount(h(ModelMenu, { anchor, onClose: () => { closed = true; } }));

	try {
		await pressButton(document.querySelector('[data-model="qa/1"] button')!);
		const dialog = document.querySelector("[data-ly-modal]");
		assert.ok(dialog);

		// 只按下，不松手：这就是 Popover 判定「点在外面」的那个时刻。
		await fire(dialog.querySelector("button")!, new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
		await new Promise((resolve) => setTimeout(resolve, 200));

		assert.equal(closed, false, "问题还没答，菜单不该先跑");
		assert.ok(document.querySelector("[data-ly-modal]"), "确认框也不该被连带收走");
	} finally {
		await view.unmount();
		anchor.remove();
		restore();
	}
});

test("取消不换模型，也不留下没答完的问题", async () => {
	const picked: string[] = [];
	const restore = withSession({ setModel: async (id: string) => { picked.push(id); } });

	const anchor = document.createElement("button");
	document.body.append(anchor);
	const view = await mount(h(ModelMenu, { anchor, onClose: () => {} }));

	try {
		await pressButton(document.querySelector('[data-model="qa/1"] button')!);
		const dialog = document.querySelector("[data-ly-modal]");
		assert.ok(dialog);
		const cancel = [...dialog.querySelectorAll("button")].find((each) => (each.getAttribute("aria-label") ?? each.textContent) === "取消");
		assert.ok(cancel);
		await pressButton(cancel);
		await new Promise((resolve) => setTimeout(resolve, 200));
		await finishExitAnimation();

		assert.deepEqual(picked, [], "取消就是什么都不发生");
		assert.ok(!document.querySelector("[data-ly-modal]"), "答完了就该收走");
	} finally {
		await view.unmount();
		anchor.remove();
		restore();
	}
});

test("换模型失败要说出来，而不是静悄悄退回去", async () => {
	const said: string[] = [];
	const restore = withSession({
		setModel: async () => { throw new Error("写不进去"); },
		notify: (message: string) => { said.push(message); },
	});

	const anchor = document.createElement("button");
	document.body.append(anchor);
	const view = await mount(h(ModelMenu, { anchor, onClose: () => {} }));

	try {
		await pressButton(document.querySelector('[data-model="qa/1"] button')!);
		const confirm = [...document.querySelectorAll("[data-ly-modal] button")].find((each) => (each.getAttribute("aria-label") ?? each.textContent) === "确认切换");
		assert.ok(confirm);
		await pressButton(confirm);
		await new Promise((resolve) => setTimeout(resolve, 200));
		await finishExitAnimation();
		await new Promise((resolve) => setTimeout(resolve, 20));

		assert.equal(said.length, 1, "失败必须有一句话");
		assert.match(said[0]!, /写不进去/);
	} finally {
		await view.unmount();
		anchor.remove();
		restore();
	}
});

test("没有对话记录时不问，直接换", async () => {
	const picked: string[] = [];
	const restore = withSession({ messages: [], setModel: async (id: string) => { picked.push(id); } });

	const anchor = document.createElement("button");
	document.body.append(anchor);
	const view = await mount(h(ModelMenu, { anchor, onClose: () => {} }));

	try {
		await pressButton(document.querySelector('[data-model="qa/1"] button')!);
		assert.ok(!document.querySelector("[data-ly-modal]"), "空会话没有什么可以丢的，不该拦一道");
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.deepEqual(picked, ["qa/1"]);
	} finally {
		await view.unmount();
		anchor.remove();
		restore();
	}
});

test("确认框被卸载时，已经答应的那次确认照样兑现", async () => {
	// `Overlay` 自己的保证，与菜单无关：任何「按下确认后组件就消失」的地方都靠它兜底。
	let done = 0;
	const view = await mount(h(Confirm, { title: "删掉？", confirmLabel: "删", onConfirm: () => { done++; }, onCancel: () => {} }));
	const confirm = [...document.querySelectorAll("[data-ly-modal] button")].find((each) => (each.getAttribute("aria-label") ?? each.textContent) === "删");
	assert.ok(confirm);
	await fire(confirm, new MouseEvent("click", { bubbles: true, cancelable: true }));
	assert.equal(done, 0, "动画还在播的时候不该已经做完");
	await view.unmount();
	assert.equal(done, 1, "卸载不是反悔");
});
