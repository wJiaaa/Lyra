/**
 * 拉取来的模型，导入之后是什么样。
 *
 * 上限、能力和价格按模型 ID 和 Base URL 从模型目录填一次，之后就是普通的模型配置（设置读写不改它，
 * 见 core 的 `model-catalog.test.ts`）。弹窗上显示的那个窗口也得和导入写进去的是同一个。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderConfig } from "@plume/core";

import { importedModel, windowLabel } from "../src/features/settings/model-defaults.ts";

const relay: Pick<ProviderConfig, "id" | "baseUrl"> = { id: "new-provider", baseUrl: "https://relay.example.com/v1" };
const openCodeGo: Pick<ProviderConfig, "id" | "baseUrl"> = { id: "opencode", baseUrl: "https://opencode.ai/zen/go/v1" };

test("导入按目录填上限和能力，同一端点的条目优先", () => {
	const model = importedModel(openCodeGo, "glm-5.3");
	assert.equal(model.contextWindow, 1_000_000);
	assert.equal(model.maxOutputTokens, 131_072, "OpenCode Go 端点上的 glm-5.3，不是智谱官方的条目");
	assert.equal(model.name, "glm-5.3");
	assert.equal(model.id, "opencode/glm-5.3");
});

test("目录里没有的模型，拿通用默认值", () => {
	const model = importedModel(relay, "some-private-model-v9");
	assert.deepEqual(
		{ contextWindow: model.contextWindow, maxOutputTokens: model.maxOutputTokens, supportsTools: model.supportsTools, pricing: model.pricing },
		{ contextWindow: 200_000, maxOutputTokens: 32_000, supportsTools: true, pricing: undefined },
	);
});

test("价格也从目录填", () => {
	assert.ok(importedModel(relay, "gpt-5.2-high").pricing, "价格没了，用量统计就成了一列零");
});

test("弹窗上那行字和导入写进去的是同一个数", () => {
	for (const [provider, id] of [[openCodeGo, "glm-5.3"], [relay, "some-private-model-v9"]] as const) {
		assert.equal(windowLabel(provider, id), `${Math.round(importedModel(provider, id).contextWindow / 1000)}K`);
	}
});
