/**
 * 展开指示箭头：转过去，而且是滑过去的。
 *
 * 这两条以前是每个调用点各写一遍的，于是各写各的：有的写了 `transition-transform`，有的忘了，
 * 忘了的那些在屏幕上是箭头「啪」地跳一下。跳和滑的区别没人会为它提 issue——它只是让同一个手势
 * 在应用的不同角落手感不一样。钉在这里，是因为下一个复制这段 class 的人不会想起要加过渡。
 *
 * 第二条是朝向：下拉的箭头收起时朝下、展开转到朝上（180°），树和折叠块的箭头收起时朝右、展开
 * 转到朝下（90°）。差一个角度不会报错，只会让箭头指向一个不存在的方向。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h } from "react";
import { Caret } from "../../src/ui/primitives/Caret.tsx";
import { mount } from "../helpers/mount.ts";

/** 画出来的那个 svg 的 class 列表。 */
async function classesOf(props: Parameters<typeof Caret>[0]): Promise<string[]> {
	const view = await mount(h(Caret, props));
	try {
		const svg = view.host.querySelector("svg");
		assert.ok(svg, "应该画出一个箭头");
		return (svg.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
	} finally {
		await view.unmount();
	}
}

test("收起的时候不转", async () => {
	const classes = await classesOf({ open: false });
	assert.ok(!classes.some((c) => c.startsWith("rotate-")), `不该有旋转：${classes.join(" ")}`);
});

test("下拉展开转到朝上", async () => {
	assert.ok((await classesOf({ open: true })).includes("rotate-180"));
});

test("树和折叠块展开转到朝下", async () => {
	assert.ok((await classesOf({ open: true, from: "right" })).includes("rotate-90"));
});

test("转的时候一定是滑过去的，不是跳过去的", async () => {
	// 两个状态都要有——过渡写在常驻的 class 上，而不是只在展开那一半。
	for (const open of [false, true]) {
		const classes = await classesOf({ open });
		assert.ok(
			classes.includes("transition-transform"),
			`open=${open} 少了过渡：${classes.join(" ")}`,
		);
	}
});

test("箭头自己不报名字，名字归它所在的按钮", async () => {
	const view = await mount(h(Caret, { open: false }));
	try {
		const svg = view.host.querySelector("svg");
		assert.ok(svg);
		// 一颗按钮的可访问名来自 `aria-label`；里面的字形再报一次只会读两遍。
		assert.equal(svg.getAttribute("aria-hidden"), "true");
	} finally {
		await view.unmount();
	}
});
