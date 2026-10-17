/**
 * 新建定时任务跑在项目的文件夹里，不在此刻打开的那棵工作树里。
 *
 * 从工作树会话走到「定时任务」，窗口的 `workspace` 还是那棵工作树。照它的路径建任务，任务每天都跑进
 * 一份为另一场对话检出的副本，那份副本被清理以后就再也跑不起来；读取范围也不认它，因为项目的
 * 文件夹里没有这条路径。
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, createElement as h } from "react";
import { DEFAULT_SETTINGS, type Settings } from "@plume/core";
import { LayoutProvider } from "../../src/app/layout.tsx";
import { ScheduledView } from "../../src/features/scheduled/ScheduledView.tsx";
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
	Reflect.deleteProperty(window, "plume");
});

test("a task added while a worktree is open runs in the project's folder, in the project", async () => {
	previous = useApp.getState();
	const saved: Settings[] = [];
	Object.defineProperty(window, "plume", { configurable: true, value: {} });
	useApp.setState({
		settings: { ...DEFAULT_SETTINGS, scheduledTasks: [] },
		sessions: [],
		workspace: { path: "/home/.plume/worktrees/app-1234abcd", name: "前端", projectId: "p-web", isGitRepo: true, branch: "plume/session-1234abcd", worktreeOf: "/work/app" },
		saveSettings: async (settings: Settings) => {
			saved.push(settings);
		},
	} as Partial<AppState>);
	view = await mount(h(I18nProvider, { locale: "zh-CN", children: h(LayoutProvider, { children: h(ScheduledView) }) }));
	const add = document.querySelector<HTMLButtonElement>("header button");
	assert.ok(add, "the 新建 button");
	await act(async () => {
		add.click();
	});
	const task = saved.at(-1)?.scheduledTasks.at(-1);
	assert.equal(task?.cwd, "/work/app");
	assert.equal(task?.project, "p-web");
});
