/**
 * 思考行收起时的标题：运行中是一个说「在想」的词、一段一个、不走秒；写完「思考了 N 秒」，不满一秒或说不出
 * 时长就不报数。见 `ThinkingBlock`。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h } from "react";
import { ThinkingBlock } from "../../src/features/conversation/ThinkingBlock.tsx";
import { I18nProvider } from "../../src/i18n/index.ts";
import { mount } from "../helpers/mount.ts";

type Props = { live?: boolean; startedAt?: number; durationMs?: number };

const ZH_LIVE = ["正在思考", "头脑风暴中", "琢磨一下", "理理思路", "掂量掂量", "想想怎么办"];

async function title(locale: "zh-CN" | "en", props: Props): Promise<string> {
	const view = await mount(h(I18nProvider, { locale, children: h(ThinkingBlock, { text: "先看目录\n再读配置", redacted: false, ...props }) }));
	try {
		return view.find("[data-ly-thinking] .ly-flow-summary")?.textContent?.trim() ?? "";
	} finally {
		await view.unmount();
	}
}

test("运行中：每段按开始时刻选一个词，同一段重新挂载还是那个词，不写秒数和推理内容", async () => {
	const seen = new Set<string>();
	for (let startedAt = 1_000; startedAt < 1_006; startedAt++) {
		const word = await title("zh-CN", { live: true, startedAt });
		assert.ok(ZH_LIVE.includes(word), `运行中是那几个词之一：${word}`);
		assert.equal(await title("zh-CN", { live: true, startedAt }), word, "同一段推理再挂载一次，词不变");
		seen.add(word);
	}
	assert.equal(seen.size, ZH_LIVE.length, "不同的段轮得到不同的词");
	assert.equal(await title("zh-CN", { live: true }), "正在思考", "不知道开始时刻时用第一个");
	assert.equal(await title("en", { live: true }), "Thinking");
});

test("写完说想了多久：秒向下取整（和运行指示同一种取法），过一分钟带分", async () => {
	assert.equal(await title("zh-CN", { durationMs: 12_900, startedAt: 1_001 }), "思考了 12 秒");
	assert.equal(await title("zh-CN", { durationMs: 1_000 }), "思考了 1 秒");
	assert.equal(await title("zh-CN", { durationMs: 125_000 }), "思考了 2 分 5 秒");
	assert.equal(await title("en", { durationMs: 12_400 }), "Thought for 12s");
	assert.equal(await title("en", { durationMs: 125_000 }), "Thought for 2m 5s");
});

test("不满一秒、或者说不出时长时不报数", async () => {
	// 不满一秒多半是中转把整段推理一次吐出来：量到的几毫秒不是它想了多久。
	assert.equal(await title("zh-CN", { durationMs: 4 }), "思考了一会儿");
	assert.equal(await title("zh-CN", { durationMs: 999 }), "思考了一会儿");
	assert.equal(await title("zh-CN", {}), "思考了一会儿");
	assert.equal(await title("en", {}), "Thought for a while");
});
