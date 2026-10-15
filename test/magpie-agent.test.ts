/**
 * magpie 的 Agent 插件（integrations/magpie）和 Plume 读它写的那一块（core 的 config/magpie.ts）之间的约定。
 *
 * 两头各自对、合起来错的那种：magpie 写进 `defaultModelId` 的是 `prefix + 模型 id`，Plume 合成的模型
 * 要叫同一个名字，否则选中之后 Plume 找不到那个模型，静默落回别的。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { agent, connect } from "../integrations/magpie/plume.agent.js";
import { magpieProvider } from "../packages/core/src/config/magpie.ts";

const models = [
	{ id: "cliproxyapi/gpt-6-luna", name: "GPT-6 Luna", context: 1_000_000, output: 128_000, images: true, efforts: ["none", "low", "high"] },
	{ id: "group/auto-glm", name: "GLM · routing group", context: 0, output: 0, images: false, efforts: [] },
];

function wire() {
	return connect({
		gateway: { url: "http://127.0.0.1:3425", v1: "http://127.0.0.1:3425/v1", key: "magpie-plume" },
		model: models[0],
		models,
		agent: { id: "plume", config: "/home/u/.plume/settings.json" },
	});
}

/** magpie 按点分路径写进文件之后，Plume 读到的那个 `magpie` 对象。 */
function written(out: Record<string, unknown>): Record<string, unknown> {
	const block: Record<string, unknown> = {};
	for (const [path, value] of Object.entries(out)) {
		const [head, key] = path.split(".");
		assert.equal(head, "magpie", `${path} 写在了 magpie 块以外`);
		block[key] = value;
	}
	return block;
}

test("插件说明 Plume 的模型写在哪", () => {
	assert.equal(agent.id, "plume");
	assert.equal(agent.config, "~/.plume/settings.json");
	assert.equal(agent.model, "defaultModelId");
	assert.deepEqual(agent.library, {
		instructions: "~/.plume/magpie/AGENTS.md",
		mcp: "~/.plume/magpie/mcp.json",
		mcpFormat: "claude",
		skills: "~/.plume/skills",
	});
	assert.ok(agent.icon.startsWith("data:image/png;base64,"));
});

test("magpie 用来判断是否接着的 key 单独占一个字符串键", () => {
	// magpie 只在 connect 返回的字符串值里找等于网关 key 的那一键（plugged.go 的 Mark）
	assert.equal(wire()["magpie.apiKey"], "magpie-plume");
});

test("magpie 写进 defaultModelId 的值，正是 Plume 合成出来的模型 id", () => {
	const provider = magpieProvider(written(wire()));
	assert.ok(provider);
	assert.equal(provider.baseUrl, "http://127.0.0.1:3425");
	assert.equal(provider.apiKey, "magpie-plume");
	assert.deepEqual(
		provider.models.map((model) => model.id),
		models.map((model) => agent.prefix + model.id),
	);
	// 发给网关的是 magpie 自己的 id，不带 Plume 的前缀
	assert.equal(provider.models[0].modelId, "cliproxyapi/gpt-6-luna");
});
