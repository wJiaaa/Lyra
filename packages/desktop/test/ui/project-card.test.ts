/**
 * 悬停项目那一行出来的卡：多少个聊天、由哪几个文件夹组成。
 *
 * 同名的两个项目靠这张卡分开——行上只写名字，完整路径在这里。
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createElement as h } from "react";
import { DEFAULT_SETTINGS } from "@plume/core";
import { ProjectCard } from "../../src/features/sidebar/ProjectCard.tsx";
import { I18nProvider } from "../../src/i18n/index.ts";
import { useApp, type AppState } from "../../src/store/index.ts";
import { mount, type Mounted } from "../helpers/mount.ts";

let view: Mounted | undefined;
let previous: AppState | undefined;

afterEach(async () => {
	await view?.unmount();
	view = undefined;
	if (previous) useApp.setState(previous, true);
	previous = undefined;
});

const anchor = { left: 0, top: 0, right: 240, bottom: 32, width: 240, height: 32, x: 0, y: 0 } as DOMRect;

test("a project's card names its conversations and every folder it is made of", async () => {
	previous = useApp.getState();
	useApp.setState({
		settings: { ...DEFAULT_SETTINGS, projects: [{ id: "p-eim", name: "Eim", path: "/Users/x/company/Eim", lastOpenedAt: 1, folders: ["/Users/x/company/Eim", "/Users/x/company/ECom"] }] },
	});
	view = await mount(h(I18nProvider, { locale: "zh-CN", children: h(ProjectCard, { id: "p-eim", name: "Eim", path: "/Users/x/company/Eim", count: 3, anchor }) }));
	const card = document.querySelector<HTMLElement>("[data-ly-project-card]");
	assert.ok(card);
	assert.ok(card.textContent?.includes("Eim"));
	assert.ok(card.textContent?.includes("3 个聊天"));
	assert.deepEqual([...card.querySelectorAll("[data-ly-project-card-folder]")].map((row) => row.textContent), ["~/company/Eim", "~/company/ECom"]);
});

test("a project no longer on the list still shows the folder its row opens", async () => {
	previous = useApp.getState();
	useApp.setState({ settings: { ...DEFAULT_SETTINGS, projects: [] } });
	view = await mount(h(I18nProvider, { locale: "zh-CN", children: h(ProjectCard, { id: "gone", name: "app", path: "/work/app", count: 0, anchor }) }));
	assert.deepEqual([...document.querySelectorAll("[data-ly-project-card-folder]")].map((row) => row.textContent), ["/work/app"]);
});
