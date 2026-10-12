/**
 * 思考行收起时的标题：运行中是「词 · 这段想了几秒」，词随时长往下换；写完「思考了 N 秒」，不满一秒或
 * 说不出时长就不报数。见 `ThinkingBlock`。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h } from "react";
import { ThinkingBlock } from "../../src/features/conversation/ThinkingBlock.tsx";
import { I18nProvider } from "../../src/i18n/index.ts";
import { mount } from "../helpers/mount.ts";

type Props = { live?: boolean; startedAt?: number; durationMs?: number };

async function title(locale: "zh-CN" | "en", props: Props): Promise<string> {
	const view = await mount(h(I18nProvider, { locale, children: h(ThinkingBlock, { text: "先看目录\n再读配置", redacted: false, ...props }) }));
	try {
		return view.find("[data-ly-thinking] .ly-flow-summary")?.textContent?.trim() ?? "";
	} finally {
		await view.unmount();
	}
}

/** 已经想了这么久的一段。 */
const thinking = (ms: number): Props => ({ live: true, startedAt: Date.now() - ms });

test("运行中：词随这一段想的时长往下换，后面跟着秒数，不写推理内容", async () => {
	assert.equal(await title("zh-CN", thinking(5_000)), "正在思考5s");
	assert.equal(await title("zh-CN", thinking(12_000)), "琢磨一下12s");
	assert.equal(await title("zh-CN", thinking(25_000)), "头脑风暴中25s");
	assert.equal(await title("zh-CN", thinking(45_000)), "理理思路45s");
	assert.equal(await title("zh-CN", thinking(80_000)), "掂量掂量1m 20s");
	assert.equal(await title("zh-CN", thinking(115_000)), "想想怎么办1m 55s");
	assert.equal(await title("en", thinking(5_000)), "Thinking5s");
});

test("运行中：走完一遍以后慢慢轮回去，不再说开场那个「正在思考」", async () => {
	assert.equal(await title("zh-CN", thinking(160_000)), "琢磨一下2m 40s");
	assert.equal(await title("zh-CN", thinking(200_000)), "头脑风暴中3m 20s");
});

test("运行中说不出开始时刻：用第一个词，不报秒", async () => {
	assert.equal(await title("zh-CN", { live: true }), "正在思考");
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
