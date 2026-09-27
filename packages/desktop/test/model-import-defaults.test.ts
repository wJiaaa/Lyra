/**
 * 拉取来的模型，导入之后是什么样。
 *
 * 上限和能力来自智能配置规则，按模型 ID、API 格式和 Base URL 匹配；价格仍查离线目录。导入的行标成
 * `smart`，设置每次读写都会重新套一遍推荐值，所以往返之后必须还是同一组数——弹窗上显示的那个窗口
 * 也得和导入写进去的是同一个。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderConfig } from "@lyra/core";
import { withCatalogPricing } from "@lyra/core/model-catalog";
import { resolveModelRules, withSmartConfig } from "@lyra/core/model-rules";

import { importedModel, windowLabel } from "../src/features/settings/model-defaults.ts";

const relay: Pick<ProviderConfig, "id" | "baseUrl" | "api"> = { id: "new-provider", baseUrl: "https://relay.example.com/v1", api: "openai-responses" };
const openCodeGo: Pick<ProviderConfig, "id" | "baseUrl" | "api"> = { id: "opencode", baseUrl: "https://opencode.ai/zen/go/v1", api: "openai-chat-completions" };

test("导入按智能配置取上限和能力，站点规则优先", () => {
	const model = importedModel(openCodeGo, "glm-5.3");
	assert.equal(model.metadataSource, "smart");
	assert.equal(model.contextWindow, 1_000_000);
	assert.equal(model.maxOutputTokens, 131_072, "OpenCode Go 上的 glm-5.3，不是智谱官方的 128000");
	assert.equal(model.name, "glm-5.3");
	assert.equal(model.id, "opencode/glm-5.3");
});

test("规则不认得的模型，拿兜底的推荐值", () => {
	const model = importedModel(relay, "some-private-model-v9");
	assert.deepEqual(
		{ contextWindow: model.contextWindow, maxOutputTokens: model.maxOutputTokens, supportsTools: model.supportsTools },
		{ contextWindow: 200_000, maxOutputTokens: 32_000, supportsTools: true },
	);
});

test("存一遍读一遍，值不变", () => {
	const model = importedModel(openCodeGo, "glm-5.3");
	const once = withCatalogPricing(openCodeGo, withSmartConfig(openCodeGo, model));
	assert.deepEqual(withCatalogPricing(openCodeGo, withSmartConfig(openCodeGo, once)), model);
});

test("价格仍然从离线目录来", () => {
	assert.ok(importedModel(relay, "gemini-3.5-flash-low").pricing, "价格没了，用量统计就成了一列零");
});

test("弹窗上那行字和导入写进去的是同一个数", () => {
	for (const [provider, id] of [[openCodeGo, "glm-5.3"], [relay, "some-private-model-v9"]] as const) {
		assert.equal(windowLabel(provider, id), `${Math.round(importedModel(provider, id).contextWindow / 1000)}K`);
		assert.equal(importedModel(provider, id).contextWindow, resolveModelRules(provider, id).config.contextWindow);
	}
});
