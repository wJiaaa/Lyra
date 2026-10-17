/**
 * 菜单开着时，压住的是菜单外面的气泡，不是菜单自己那几项的。
 *
 * 菜单一挂上就占住 `claimHoverSuppression`，本意是旁边那一行、侧栏的信息卡别趁指针路过浮到菜单上来。
 * 从前 tooltip 只问「有没有人占着」，于是菜单里每一项自己的提示也一起哑了：项目菜单悬停看完整路径、
 * 模型菜单那颗星「收藏」，从来没显示过。对话框早就因为同样的理由不持续压着（见 `hover-layers.test.ts`）。
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { claimHoverSuppression } from "../../src/ui/overlay/hover-layers.ts";
import { installTooltips } from "../../src/ui/overlay/tooltip.ts";

installTooltips();

const DELAY = 480;

async function shown(target: HTMLElement): Promise<boolean> {
	target.dispatchEvent(new window.PointerEvent("pointerover", { bubbles: true }));
	await new Promise((resolve) => setTimeout(resolve, DELAY));
	const tip = document.querySelector<HTMLElement>(".ly-tooltip");
	const visible = Boolean(tip && !tip.hidden && tip.textContent === target.dataset.lyTip);
	target.dispatchEvent(new window.PointerEvent("pointerout", { bubbles: true }));
	document.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true }));
	return visible;
}

function tipped(label: string, parent: HTMLElement = document.body): HTMLElement {
	const el = document.createElement("button");
	el.dataset.lyTip = label;
	parent.append(el);
	return el;
}

after(() => {
	document.body.replaceChildren();
});

test("with a menu open, a row of that menu still shows its tooltip; things outside it do not", async () => {
	const menu = document.createElement("div");
	menu.setAttribute("role", "menu");
	menu.dataset.lyPopover = "0";
	document.body.append(menu);
	const release = claimHoverSuppression();
	try {
		assert.equal(await shown(tipped("/Users/x/work/a/app", menu)), true, "the menu's own row");
		assert.equal(await shown(tipped("归档")), false, "a button beside the menu");
	} finally {
		release();
		menu.remove();
	}
});
