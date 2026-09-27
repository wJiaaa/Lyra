/**
 * 模型设置页的目录状态行：显示当前目录，点「立即更新」让主进程拉一次，换上主进程的新目录并报结果。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h } from "react";
import { DEFAULT_SETTINGS } from "@lyra/core";
import { activeModelCatalog, resetModelCatalog, type ModelCatalogDocument } from "@lyra/core/model-catalog";

import { ModelSettings } from "../../src/features/settings/ModelSettings.tsx";
import { useApp } from "../../src/store/index.ts";
import { click, mount } from "../helpers/mount.ts";

const statusLine = () => document.querySelector("[data-ly-model-catalog]")?.textContent ?? "";

test("立即更新：主进程换了目录，页面跟着换版本并报已更新；失败时报原因", async () => {
	const remote: ModelCatalogDocument = {
		...activeModelCatalog(),
		source: { ...activeModelCatalog().source, revision: "rev-remote", updatedAt: "2099-01-01T00:00:00.000Z" },
		providers: [{ id: "openai", models: [activeModelCatalog().providers.flatMap((provider) => provider.models)[0]] }],
	};
	let result: { status: string; error?: string } = { status: "updated" };
	let updates = 0;
	Reflect.set(window, "lyra", {
		providers: {
			updateModelCatalog: async () => { updates += 1; return { ...result, source: remote.source }; },
			modelCatalog: async (known?: string) => (known === remote.source.revision ? null : remote),
		},
	});
	useApp.setState({ settings: { ...DEFAULT_SETTINGS, providers: [] } });
	const view = await mount(h(ModelSettings));
	try {
		assert.match(statusLine(), /模型目录：pi\.dev · 更新于 .+ · \d+ 个模型 · 立即更新/);
		const button = () => [...document.querySelectorAll("[data-ly-model-catalog] button")][0] as HTMLButtonElement;
		await click(button());
		assert.equal(updates, 1);
		assert.equal(useApp.getState().catalogRevision, "rev-remote");
		assert.match(statusLine(), /1 个模型 · 立即更新 · 已更新/);

		result = { status: "failed", error: "HTTP 503" };
		await click(button());
		assert.match(statusLine(), /更新失败：HTTP 503/);
	} finally {
		await view.unmount();
		Reflect.deleteProperty(window, "lyra");
		resetModelCatalog();
		useApp.setState({ settings: null, catalogRevision: activeModelCatalog().source.revision });
	}
});
