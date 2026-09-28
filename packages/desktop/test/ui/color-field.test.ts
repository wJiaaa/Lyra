/**
 * 外观页的颜色输入框：不带 `#` 的值也要画得出来，存回去时补上 `#`。
 *
 * 手打的 `1A1C1F` 曾被原样存下，又原样写进色块的 `background`——CSS 不认，色块透明，字却按深色底
 * 算成白色，前景那一格在白色的行上整个看不见。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h } from "react";

import { ColorField } from "../../src/features/settings/appearance-controls.tsx";
import { fire, mount } from "../helpers/mount.ts";

async function type(input: HTMLInputElement, value: string) {
	const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
	assert.ok(setter);
	setter.call(input, value);
	await fire(input, new Event("input", { bubbles: true }));
}

test("ColorField: 已经存成没有 # 的值，照样画出色块和文字", async () => {
	const view = await mount(h(ColorField, { value: "1A1C1F", onChange: () => {}, label: "前景" }));
	const input = view.find<HTMLInputElement>("input");
	const swatch = input.closest("label") as HTMLElement;

	assert.equal(input.value, "#1A1C1F", "显示成规范写法");
	assert.notEqual(swatch.style.background, "", "色块的底色是一条有效的声明");
	assert.notEqual(swatch.style.background, "transparent");
	await view.unmount();
});

test("ColorField: 手打不带 # 的颜色，存下来的是 #RRGGBB", async () => {
	const saved: string[] = [];
	const view = await mount(h(ColorField, { value: "#FFFFFF", onChange: (value: string) => saved.push(value), label: "前景" }));

	await type(view.find<HTMLInputElement>("input"), "262626");
	assert.deepEqual(saved, ["#262626"]);
	await view.unmount();
});
