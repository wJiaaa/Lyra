/**
 * 模型列表的批量删除：先进「选择」，勾几行，一次删掉。
 *
 * 从前删除只在每行的「更多」菜单里，一次一个、每个都要确认一遍；清掉一个中转下线的十几个模型
 * 要点几十下。
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, createElement as h } from "react";
import type { ModelConfig, Settings } from "@plume/core";
import { ProviderModels } from "../../src/features/settings/ProviderModels.tsx";
import { I18nProvider } from "../../src/i18n/index.ts";
import { useApp } from "../../src/store/index.ts";
import { click, mount } from "../helpers/mount.ts";

const previous = useApp.getState();
afterEach(() => useApp.setState(previous, true));

const model = (modelId: string): ModelConfig => ({
	id: `relay/${modelId}`,
	providerId: "relay",
	modelId,
	name: modelId,
	contextWindow: 128_000,
	maxOutputTokens: 8192,
	supportsThinking: false,
	supportsImages: false,
	supportsTools: true,
});

async function draw(models: ModelConfig[], defaultModelId: string | null = null) {
	useApp.setState({ settings: { imageModelId: null } as unknown as Settings });
	const removed: string[][] = [];
	const edited: (ModelConfig | null)[] = [];
	const view = await mount(
		h(I18nProvider, {
			locale: "zh-CN",
			children: h(ProviderModels, {
				models,
				defaultModelId,
				testing: false,
				onEdit: (one: ModelConfig | null) => edited.push(one),
				onRemove: () => {},
				onRemoveMany: (ids: string[]) => removed.push(ids),
				onSetDefault: () => {},
			}),
		}),
	);
	return { view, removed, edited };
}

const row = (modelId: string) => document.querySelector<HTMLElement>(`[data-ly-model-row="${modelId}"]`)!;
const button = (name: string) => document.querySelector<HTMLButtonElement>(`[data-ly-model-${name}]`);

async function eventually(check: () => boolean, what: string) {
	for (let i = 0; i < 100 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
	assert.ok(check(), what);
}

test("选中的几个一次删掉，删完退出选择", async () => {
	const { view, removed, edited } = await draw([model("a"), model("b"), model("c")], "relay/b");
	await click(button("select")!);
	await click(row("a"));
	await click(row("b"));
	assert.equal(edited.length, 0, "选择模式里点行是勾选，不是打开编辑");
	assert.equal(row("a").getAttribute("aria-checked"), "true");
	assert.equal(row("c").getAttribute("aria-checked"), "false");
	assert.equal(button("delete-selected")!.textContent, "删除 2 个");

	await click(button("delete-selected")!);
	assert.match(document.body.textContent ?? "", /删除选中的 2 个模型？/);
	assert.match(document.body.textContent ?? "", /其中有当前的默认模型/, "勾了默认模型要说一句");
	const [, confirm] = document.querySelectorAll<HTMLButtonElement>("[data-ly-modal] button");
	await click(confirm!);
	assert.equal(removed.length, 0, "确认框退场完才删");
	await act(async () => {
		document.querySelector(".ly-dialog-out")?.dispatchEvent(new Event("animationend", { bubbles: true }));
	});
	await eventually(() => removed.length === 1, "确认之后才删");
	assert.deepEqual(removed[0], ["relay/a", "relay/b"]);
	await eventually(() => button("select") !== null, "删完回到平时的样子");
	await view.unmount();
});

test("全选、取消全选；一个都没勾时删除按钮不能点", async () => {
	const { view } = await draw([model("a"), model("b")]);
	await click(button("select")!);
	assert.equal(button("delete-selected")!.disabled, true);
	await click(button("select-all")!);
	assert.equal(button("delete-selected")!.textContent, "删除 2 个");
	assert.equal(button("select-all")!.textContent, "取消全选");
	await click(button("select-all")!);
	assert.equal(button("delete-selected")!.disabled, true);
	await click(button("select-done")!);
	assert.ok(button("select"), "完成之后回到平时的样子");
	assert.equal(row("a").getAttribute("role"), null);
	await view.unmount();
});

test("只有一个模型时不出「选择」", async () => {
	const { view } = await draw([model("a")]);
	assert.equal(button("select"), null);
	await view.unmount();
});
