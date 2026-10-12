/**
 * 连接中断那一行，点字也能展开原文，不只是末尾那颗箭头。
 *
 * 别的过程行都是整行可点，这一行从前只认箭头：点在「连接中断，正在重试」上什么也不发生。
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createElement as h } from "react";
import { HiccupRow } from "../../src/features/conversation/HiccupTrace.tsx";
import { I18nProvider } from "../../src/i18n/index.ts";
import type { Hiccup } from "../../src/lib/hiccup.ts";
import { click, mount, type Mounted } from "../helpers/mount.ts";

const RECOVERED: Hiccup = {
	id: "hiccup-1", at: 2, attempts: 2, until: 0, summary: "连接中断", detail: "connection reset by peer after 12384 bytes",
	kind: "network", fingerprint: "reset", repeated: 1, outcome: "recovered",
};

let view: Mounted | undefined;

afterEach(async () => {
	await view?.unmount();
	view = undefined;
});

const render = (hiccup: Hiccup) => mount(h(I18nProvider, { locale: "zh-CN", children: h(HiccupRow, { hiccup }) }));

test("clicking the words opens the detail, and clicking them again closes it", async () => {
	view = await render(RECOVERED);
	await click(view.find("[data-ly-tip]"));
	assert.equal(view.find("pre").textContent, RECOVERED.detail);
	await click(view.find("[data-ly-tip]"));
	assert.equal(view.host.querySelector("pre"), null);
});

test("the words, the icon and the chevron are one button, and 「继续」 sits beside it", async () => {
	view = await render({ ...RECOVERED, outcome: "gave_up" });
	const toggle = view.find("button[aria-expanded]");
	assert.ok(toggle.querySelector("[data-ly-tip]"), "the words are inside the toggle");
	assert.equal(toggle.querySelectorAll("button").length, 0, "no button inside a button");
	assert.ok(view.find("[data-resume-continue]"), "the next step is still offered");
	assert.equal(toggle.contains(view.find("[data-resume-continue]")), false);
});

test("a row with nothing more to show does not open", async () => {
	view = await render({ ...RECOVERED, detail: undefined });
	await click(view.find("[data-ly-tip]"));
	assert.equal(view.host.querySelector("pre"), null);
	assert.equal(view.host.querySelector("button"), null, "nothing to open, nothing to press");
});
