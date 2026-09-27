/**
 * 模型编辑器里的智能配置：推荐值随模型 ID 变；改一项只让那一项脱离推荐；恢复推荐清掉覆盖；
 * 关掉开关把看到的值整份存成手动。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h } from "react";
import type { ModelConfig } from "@lyra/core";

import { ModelEditor } from "../../src/features/settings/ModelEditor.tsx";
import { click, fire, mount } from "../helpers/mount.ts";

const provider = { id: "opencode", baseUrl: "https://opencode.ai/zen/go/v1", api: "openai-chat-completions" as const };

/** The input inside the field whose label starts with `label`. */
function field(label: string): HTMLInputElement {
	const found = [...document.querySelectorAll("label")].find((node) => node.textContent?.startsWith(label))?.querySelector("input");
	assert.ok(found, `no field labelled ${label}`);
	return found;
}

async function type(input: HTMLInputElement, value: string) {
	const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
	assert.ok(setter);
	setter.call(input, value);
	await fire(input, new Event("input", { bubbles: true }));
}

const smartSwitch = () => document.querySelector<HTMLElement>('[role="switch"]')!;
const button = (text: string) => [...document.querySelectorAll("button")].find((node) => node.textContent === text || node.getAttribute("aria-label") === text);

async function save(): Promise<void> {
	const saveButton = button("保存");
	assert.ok(saveButton);
	await click(saveButton);
	const overlay = document.querySelector("[data-ly-modal]");
	if (overlay) await fire(overlay, new Event("animationend", { bubbles: true }));
}

test("新模型默认智能配置：填 ID 带出推荐值，改一项只锁那一项，恢复推荐清掉覆盖", async () => {
	let saved: ModelConfig | undefined;
	const view = await mount(h(ModelEditor, { provider, model: null, onSave: (next) => { saved = next; }, onCancel: () => {} }));
	try {
		assert.equal(smartSwitch().getAttribute("aria-checked"), "true");
		await type(field("模型 ID"), "glm-5.3");
		assert.equal(field("上下文窗口").value, "1000000");
		assert.equal(field("最大输出").value, "131072", "OpenCode Go 的站点规则");

		await type(field("上下文窗口"), "64000");
		assert.match(document.body.textContent ?? "", /上下文窗口（token） · 手动/);
		assert.match(document.body.textContent ?? "", /1 项已手动设置/);
		assert.equal(field("最大输出").value, "64000", "跟随推荐的输出上限不超过手动定的窗口");

		await save();
		assert.equal(saved?.metadataSource, "smart");
		assert.deepEqual(saved?.overrides, ["contextWindow"]);
		assert.equal(saved?.contextWindow, 64_000);
	} finally {
		await view.unmount();
	}
});

test("恢复推荐回到规则值；关掉智能配置把眼前的值存成手动", async () => {
	let saved: ModelConfig | undefined;
	const model: ModelConfig = {
		id: "opencode/glm-5.3", providerId: "opencode", modelId: "glm-5.3", name: "glm-5.3",
		contextWindow: 64_000, maxOutputTokens: 64_000, supportsThinking: true, supportsImages: false, supportsTools: true,
		metadataSource: "smart", overrides: ["contextWindow"],
	};
	const view = await mount(h(ModelEditor, { provider, model, onSave: (next) => { saved = next; }, onCancel: () => {} }));
	try {
		assert.equal(field("上下文窗口").value, "64000");
		const restore = button("恢复推荐");
		assert.ok(restore);
		await click(restore);
		assert.equal(field("上下文窗口").value, "1000000");

		await click(smartSwitch());
		assert.equal(smartSwitch().getAttribute("aria-checked"), "false");
		await save();
		assert.equal(saved?.metadataSource, "manual");
		assert.equal(saved?.overrides, undefined);
		assert.equal(saved?.contextWindow, 1_000_000, "关掉时存的是当时看到的推荐值");
	} finally {
		await view.unmount();
	}
});
