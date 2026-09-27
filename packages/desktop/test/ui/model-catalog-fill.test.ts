/**
 * 模型编辑器里的「从模型目录填入」：目录只是参考。按模型 ID 找到的条目作为建议，搜索可以选任意条目；
 * 选中就把值填进表单，之后随意手动改，保存的就是表单里的值，和目录再无关系。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h } from "react";
import type { ModelConfig } from "@lyra/core";
import { catalogFill, catalogModelFor } from "@lyra/core/model-catalog";

import { ModelEditor } from "../../src/features/settings/ModelEditor.tsx";
import { click, fire, mount } from "../helpers/mount.ts";

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

const results = () => [...document.querySelectorAll<HTMLButtonElement>('[aria-label="模型目录搜索结果"] button')];
const button = (text: string) => [...document.querySelectorAll("button")].find((node) => node.textContent === text);

async function save(): Promise<void> {
	const saveButton = button("保存");
	assert.ok(saveButton);
	await click(saveButton);
	const overlay = document.querySelector("[data-ly-modal]");
	if (overlay) await fire(overlay, new Event("animationend", { bubbles: true }));
}

test("按模型 ID 找到的条目一键填入，填完照样能改，保存的是改后的值", async () => {
	const provider = { id: "opencode", baseUrl: "https://opencode.ai/zen/go/v1" };
	const found = catalogModelFor(provider, "glm-5.3");
	assert.ok(found);
	const expected = catalogFill(found.provider.id, found.model);
	let saved: ModelConfig | undefined;
	const view = await mount(h(ModelEditor, { provider, model: null, onSave: (next) => { saved = next; }, onCancel: () => {} }));
	try {
		assert.equal(field("上下文窗口").value, "200000", "没选之前是通用默认值");
		await type(field("模型 ID"), "glm-5.3");
		assert.equal(field("上下文窗口").value, "200000", "输入 ID 不会自动改值");
		assert.equal(results().length, 1);
		assert.match(results()[0].textContent ?? "", /按模型 ID 找到：glm-5\.3/);

		await click(results()[0]);
		assert.equal(field("上下文窗口").value, String(expected.contextWindow));
		assert.equal(field("最大输出").value, String(expected.maxOutputTokens));

		await type(field("上下文窗口"), "64000");
		await type(field("最大输出"), "32000");
		await save();
		assert.equal(saved?.contextWindow, 64_000);
		assert.equal(saved?.maxOutputTokens, 32_000);
		assert.deepEqual(saved?.pricing, expected.pricing, "价格按填入的那份存");
		assert.equal(Object.hasOwn(saved ?? {}, "catalogRef"), false);
	} finally {
		await view.unmount();
	}
});

test("没匹配上的别名可以搜索任意条目填入，模型 ID 不变；改了价格就存成手动价格", async () => {
	const relay = { id: "relay", baseUrl: "https://relay.example/v1" };
	const google = catalogModelFor({ baseUrl: "https://generativelanguage.googleapis.com/v1beta" }, "gemini-2.5-pro");
	assert.ok(google?.model.outputPrice !== undefined);
	let saved: ModelConfig | undefined;
	const view = await mount(h(ModelEditor, { provider: relay, model: null, onSave: (next) => { saved = next; }, onCancel: () => {} }));
	try {
		await type(field("模型 ID"), "gemini-pro-agent");
		assert.equal(results().length, 0, "找不到就不给建议");

		const search = document.querySelector<HTMLInputElement>('[aria-label="搜索模型目录"]');
		assert.ok(search);
		await type(search, "google gemini-2.5-pro");
		const pick = results().find((node) => node.querySelector("span")?.textContent === "gemini-2.5-pro");
		assert.ok(pick);
		await click(pick);
		assert.equal(field("上下文窗口").value, String(google.model.contextWindow));
		assert.match(document.body.textContent ?? "", /价格从 pi\.dev 模型目录填入/);

		await type(field("输入价格"), "9");
		assert.match(document.body.textContent ?? "", /当前使用手动填写的价格/);
		await save();
		assert.equal(saved?.modelId, "gemini-pro-agent");
		assert.deepEqual(saved?.pricing, { input: 9, output: google.model.outputPrice, cacheRead: google.model.cacheReadPrice, cacheWrite: google.model.cacheWritePrice, source: "manual" });
	} finally {
		await view.unmount();
	}
});

test("编辑已有模型：原样保存，不会被目录改写", async () => {
	const provider = { id: "opencode", baseUrl: "https://opencode.ai/zen/go/v1" };
	const model: ModelConfig = {
		id: "opencode/glm-5.3", providerId: "opencode", modelId: "glm-5.3", name: "glm-5.3",
		contextWindow: 64_000, maxOutputTokens: 8_000, supportsThinking: false, supportsImages: false, supportsTools: true,
		pricing: { input: 1, output: 2, source: "manual" },
	};
	let saved: ModelConfig | undefined;
	const view = await mount(h(ModelEditor, { provider, model, onSave: (next) => { saved = next; }, onCancel: () => {} }));
	try {
		assert.equal(field("上下文窗口").value, "64000");
		await save();
		assert.deepEqual(saved, model);
	} finally {
		await view.unmount();
	}
});
