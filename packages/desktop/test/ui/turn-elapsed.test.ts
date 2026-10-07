/**
 * 一轮外面那一行「已工作 Ns」：跑完后它只说花了多久，里面的东西收着、点开才画。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h } from "react";
import { TurnElapsed } from "../../src/features/conversation/TurnElapsed.tsx";
import { click, mount } from "../helpers/mount.ts";

const inside = h("div", { "data-probe": "inside" }, "过程");

test("a finished turn's line says only how long it took, and opens onto what it hides", async () => {
	const view = await mount(h(TurnElapsed, { running: false, durationMs: 22_400, stateKey: "s:turn:a", children: inside }));
	try {
		assert.match(view.text(), /22\.4s/, "和回答底下那枚徽章同一个数");
		assert.equal(view.all("[data-probe]").length, 0, "收着的时候里面的东西不在 DOM 里");
		assert.ok(view.find("[data-ly-turn-rule]"), "底下那条线在");
		await click(view.find<HTMLButtonElement>("button[aria-expanded]"));
		assert.equal(view.all("[data-probe]").length, 1, "点开后原样画出来");
	} finally {
		await view.unmount();
	}
});
