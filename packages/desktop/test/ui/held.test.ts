/**
 * 一句话至少挂多久才换：`useHeldKey`。
 *
 * 盯两件事：挂满以前来的几个不排队，到点直接换成最新的；停留时长比滚进来的动画长，不然上一句还没落定
 * 下一句就开始滚。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as h } from "react";
import { HOLD_MS, useHeldKey } from "../../src/ui/motion/held.ts";
import { DURATION } from "../../src/ui/motion/tokens.ts";
import { mount } from "../helpers/mount.ts";

function Probe({ value, ms }: { value: string; ms: number }) {
	return h("span", null, useHeldKey(value, ms));
}

const wait = (ms: number) => act(() => new Promise<void>((done) => setTimeout(done, ms)));

test("a key stays until it has been shown long enough, then jumps to the newest one", async () => {
	const seen: string[] = [];
	const view = await mount(h(Probe, { value: "a", ms: 120 }));
	const record = () => seen.push(view.text());
	try {
		record();
		await view.rerender(h(Probe, { value: "b", ms: 120 }));
		record();
		await view.rerender(h(Probe, { value: "c", ms: 120 }));
		record();
		assert.deepEqual(seen, ["a", "a", "a"], "挂上的那一句也要待满，不是一来就能被换掉");

		await wait(170);
		assert.equal(view.text(), "c", "到点换成最新的那个，中间来过的 b 跳过");

		await wait(170);
		await view.rerender(h(Probe, { value: "d", ms: 120 }));
		assert.equal(view.text(), "d", "已经待满的那一句，新的一来当场就换");
	} finally {
		await view.unmount();
	}
});

test("the hold outlasts the roll-in, so a line has settled before the next one rolls", () => {
	assert.ok(HOLD_MS > DURATION.slow, `HOLD_MS (${HOLD_MS}) must be longer than the roll-in (${DURATION.slow})`);
});
