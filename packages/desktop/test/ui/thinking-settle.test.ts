/**
 * 思考行什么时候算写完、每一句在行上留多久——见 `ThinkingBlock` 的 `useTyped`。
 *
 * 钉住两件事：推理后面接着说话、调工具之后，哪怕这一轮还在跑，行也要停下来收成第一句，不再一直顶着
 * 渐隐写；一串又短又快的句子，每一句写完都停够了再换，落后太多就跳过中间的。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as h } from "react";
import { ThinkingBlock } from "../../src/features/conversation/ThinkingBlock.tsx";
import { I18nProvider } from "../../src/i18n/index.ts";
import { mount } from "../helpers/mount.ts";

const frames = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
const block = (props: { text: string; live: boolean; writing: boolean }) =>
	h(I18nProvider, { locale: "zh-CN", children: h(ThinkingBlock, { redacted: false, ...props }) });

test("推理后面有了别的内容，这一轮还在跑，行也写完收起", async () => {
	const text = "先看目录\n再读入口";
	const view = await mount(block({ text, live: true, writing: true }));
	try {
		await frames(300);
		assert.ok(view.find("[data-follow-end]"), "字还在到时跟着写");

		// 接着说话、派了子任务：`live` 仍是真的（这一轮在跑），字不再来。
		await view.rerender(block({ text, live: true, writing: false }));
		await frames(3000);
		assert.equal(view.all("[data-follow-end]").length, 0, "写完停够之后不再跟着写");
		assert.equal(view.find(".ly-flow-summary")?.textContent, "先看目录", "收起行是开头那句");
	} finally {
		await view.unmount();
	}
});

test("又短又快的句子每句停够才换，积压的中间句跳过", async () => {
	const view = await mount(block({ text: "甲一", live: true, writing: true }));
	try {
		await frames(100);
		// 一口气又来了三句：比排队上限多一句。
		await view.rerender(block({ text: "甲一\n乙二\n丙三\n丁四", live: true, writing: true }));

		const shown: { text: string; since: number; until: number }[] = [];
		const start = performance.now();
		for (let i = 0; i < 80; i++) {
			await frames(50);
			const now = performance.now() - start;
			const text = view.find(".ly-flow-summary")?.textContent ?? "";
			const last = shown[shown.length - 1];
			if (last?.text === text) last.until = now;
			else shown.push({ text, since: now, until: now });
		}

		const whole = shown.filter((entry) => ["甲一", "乙二", "丙三", "丁四"].includes(entry.text));
		assert.deepEqual(
			whole.map((entry) => entry.text),
			["甲一", "丙三", "丁四"],
			`中间那句跳过，其余依次出现：${JSON.stringify(shown)}`,
		);
		// 写完的句子在行上至少停一秒上下（停留 1.2 秒，采样每 50ms 一次）。
		for (const entry of whole.slice(0, -1)) {
			assert.ok(entry.until - entry.since >= 1000, `「${entry.text}」只停了 ${Math.round(entry.until - entry.since)}ms`);
		}
	} finally {
		await view.unmount();
	}
});
