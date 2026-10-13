/**
 * Finding a model in a long picker: the rail narrows to one maker, and the search field drives the
 * list from the keyboard — arrows move one highlight, Enter takes it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h } from "react";
import { DEFAULT_SETTINGS, type Settings } from "@plume/core";
import { ModelSelect } from "../../src/features/models/index.ts";
import { ModelMenu } from "../../src/features/models/ModelMenu.tsx";
import { useApp } from "../../src/store/index.ts";
import { click, fire, mount, press } from "../helpers/mount.ts";

const names = ["claude-opus-5", "claude-sonnet-5", "gpt-6", "gpt-6-mini", "deepseek-v4", "deepseek-v4-flash", "my-finetune", "glm-5"];
const models = names.map((name) => ({ id: `qa/${name}`, modelId: name, providerId: "qa", name, supportsThinking: true, supportsImages: false, supportsTools: true, contextWindow: 128000, maxOutputTokens: 8192 }));
const settings: Settings = { ...DEFAULT_SETTINGS, providers: [{ id: "qa", name: "QA", api: "openai-responses", apiKey: "test", baseUrl: "http://localhost", enabled: true, models }], defaultModelId: "qa/gpt-6", favoriteModelIds: [] };

const drawn = (menu: Element) => [...menu.querySelectorAll<HTMLElement>("[data-model]")].map((row) => row.dataset.model);

async function open() {
	let chosen = "";
	useApp.setState({ settings });
	const view = await mount(h(ModelSelect, { ariaLabel: "Test model", value: "qa/gpt-6", inheritLabel: "继承", onChange: (id) => { chosen = id; } }));
	await click(view.find("button"));
	const menu = document.querySelector('[aria-label="选择模型"]');
	assert.ok(menu);
	return { view, menu, chosen: () => chosen };
}

test("the rail narrows the list to one maker and back", async () => {
	const { view, menu } = await open();
	try {
		const rail = menu.querySelector('nav[aria-label="按模型厂商筛选"]');
		assert.ok(rail, "eight models from several makers get a rail");
		const labels = [...rail.querySelectorAll("button")].map((button) => button.getAttribute("aria-label"));
		assert.deepEqual(labels, ["全部模型", "Claude", "OpenAI", "DeepSeek", "其他"]);

		await click(rail.querySelector('[aria-label="DeepSeek"]')!);
		assert.deepEqual(drawn(menu), ["qa/deepseek-v4", "qa/deepseek-v4-flash"]);

		await click(rail.querySelector('[aria-label="其他"]')!);
		assert.deepEqual(drawn(menu), ["qa/my-finetune", "qa/glm-5"]);

		await click(rail.querySelector('[aria-label="全部模型"]')!);
		assert.equal(drawn(menu).length, names.length);
	} finally {
		await view.unmount();
	}
});

test("arrows move one highlight and Enter takes it, from the search field", async () => {
	const { view, menu, chosen } = await open();
	try {
		const search = menu.querySelector("input");
		assert.ok(search);
		const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
		assert.ok(setter);
		setter.call(search, "gpt");
		await fire(search, new Event("input", { bubbles: true }));
		assert.deepEqual(drawn(menu), ["qa/gpt-6", "qa/gpt-6-mini"]);

		const lit = () => [...menu.querySelectorAll<HTMLElement>('[data-model][data-active="true"]')].map((row) => row.dataset.model);
		assert.deepEqual(lit(), ["qa/gpt-6"], "typing puts the highlight on the top match");
		await press(search, "ArrowDown");
		assert.deepEqual(lit(), ["qa/gpt-6-mini"]);
		await press(search, "ArrowDown");
		assert.deepEqual(lit(), ["qa/gpt-6"], "and wraps around");
		await press(search, "ArrowUp");
		await press(search, "Enter");
		assert.equal(chosen(), "qa/gpt-6-mini");
	} finally {
		await view.unmount();
	}
});

test("设默认模型不在这里：是不是默认，菜单里都没有那一行（去设置页的模型里设）", async () => {
	const session = (modelId: string) =>
		({ id: "s1", title: "会话", cwd: "/tmp", projectId: "p", projectName: "P", createdAt: 1, updatedAt: 1, modelId, messageCount: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } }) as never;
	const anchor = document.createElement("button");
	document.body.append(anchor);
	try {
		for (const modelId of ["qa/gpt-6", "qa/glm-5"]) {
			useApp.setState({ settings, meta: session(modelId), activeSessionId: "s1", messages: [] });
			const view = await mount(h(ModelMenu, { anchor, onClose: () => {} }));
			const text = document.querySelector('[aria-label="选择模型"]')?.textContent ?? "";
			assert.doesNotMatch(text, /默认模型/, modelId);
			await view.unmount();
		}
	} finally {
		anchor.remove();
	}
});
