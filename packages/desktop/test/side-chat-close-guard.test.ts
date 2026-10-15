/**
 * 关侧边聊天前什么时候问一句（`features/sidechat/close-guard.ts`）。
 *
 * 守的是两头：有东西才问——空的一格也问，人就习惯性点「确定」；「不再询问」只在真关了时记——勾上
 * 又点取消，等于这次没答应。
 */

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

const store = new Map<string, string>();
Object.assign(globalThis, {
	localStorage: {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => void store.set(key, String(value)),
		removeItem: (key: string) => void store.delete(key),
	},
});

const { askBeforeClosing, showingSide, useSideCloseQuestion } = await import("../src/features/sidechat/close-guard.ts");

beforeEach(() => {
	store.clear();
	useSideCloseQuestion.setState({ asking: null });
});

test("nothing in it: closes without asking", async () => {
	const hide = showingSide("s1\0a");
	assert.equal(await askBeforeClosing("s1\0a", false), true);
	assert.equal(useSideCloseQuestion.getState().asking, null);
	hide();
});

test("no pane showing it: closes without asking, so the close never hangs", async () => {
	assert.equal(await askBeforeClosing("s1\0a", true), true);
	assert.equal(useSideCloseQuestion.getState().asking, null);
});

test("something in it: asks, and the answer decides", async () => {
	const hide = showingSide("s1\0a");
	const kept = askBeforeClosing("s1\0a", true);
	assert.equal(useSideCloseQuestion.getState().asking?.key, "s1\0a");
	useSideCloseQuestion.getState().asking!.answer(false);
	assert.equal(await kept, false);
	assert.equal(useSideCloseQuestion.getState().asking, null);

	const closed = askBeforeClosing("s1\0a", true);
	useSideCloseQuestion.getState().asking!.answer(true);
	assert.equal(await closed, true);
	hide();
});

test("don't ask again sticks only when the close went ahead", async () => {
	const hide = showingSide("s1\0a");
	const cancelled = askBeforeClosing("s1\0a", true);
	useSideCloseQuestion.getState().asking!.answer(false, true);
	await cancelled;
	const again = askBeforeClosing("s1\0a", true);
	assert.ok(useSideCloseQuestion.getState().asking, "cancelling with the box ticked must not silence the question");
	useSideCloseQuestion.getState().asking!.answer(true, true);
	await again;

	assert.equal(await askBeforeClosing("s1\0a", true), true);
	assert.equal(useSideCloseQuestion.getState().asking, null);
	hide();
});

test("a second question settles the first as keep", async () => {
	const hideA = showingSide("s1\0a");
	const hideB = showingSide("s1\0b");
	const first = askBeforeClosing("s1\0a", true);
	const second = askBeforeClosing("s1\0b", true);
	assert.equal(await first, false);
	assert.equal(useSideCloseQuestion.getState().asking?.key, "s1\0b");
	useSideCloseQuestion.getState().asking!.answer(true);
	assert.equal(await second, true);
	hideA();
	hideB();
});
