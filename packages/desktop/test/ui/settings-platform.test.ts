/**
 * 设置页上只对某个系统成立的东西，要按这台机器是什么系统来画。
 *
 * 这几条钉的都是「在 Windows / Linux 上看到了只属于 macOS 的东西」：一个在那边什么都不改的开关，
 * 以及第一帧先按 macOS 画、等 IPC 回来再改口的那一跳。
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { createElement as h, type ComponentType } from "react";
import { DEFAULT_SETTINGS, type Settings } from "@plume/core";

import { AppearanceSettings } from "../../src/features/settings/AppearanceSettings.tsx";
import { GeneralSettings } from "../../src/features/settings/GeneralSettings.tsx";
import { I18nProvider } from "../../src/i18n/index.ts";
import { useApp } from "../../src/store/index.ts";
import { mount, type Mounted } from "../helpers/mount.ts";

function withPlatform(platform: string, extra: Record<string, unknown> = {}) {
	Object.defineProperty(window, "plume", { configurable: true, value: { platform, ...extra } });
}

/**
 * Mount, look, and always unmount.
 *
 * A failed assertion that skips the unmount leaves these pages mounted, and something inside them
 * keeps the event loop alive: the file then never finishes and never says which test broke.
 */
async function look(page: ComponentType, check: (view: Mounted) => void) {
	const view = await mount(h(I18nProvider, { locale: "zh-CN", children: h(page) }));
	try {
		check(view);
	} finally {
		await view.unmount();
	}
}

beforeEach(() => {
	useApp.setState({
		settings: DEFAULT_SETTINGS,
		saveSettings: async (next: Settings) => {
			useApp.setState({ settings: next });
		},
	} as never);
});

afterEach(() => {
	Reflect.deleteProperty(window, "plume");
});

test("字体平滑只在 macOS 上出现：-webkit-font-smoothing 在别的系统上什么都不改", async () => {
	for (const platform of ["win32", "linux"]) {
		withPlatform(platform);
		await look(AppearanceSettings, (view) => {
			assert.ok(!view.text().includes("字体平滑"), `${platform} 上不该出现字体平滑开关`);
			// 同一张卡片里的其余几行还在——藏的是那一行，不是整块。
			assert.ok(view.text().includes("恢复默认"));
		});
	}

	withPlatform("darwin");
	await look(AppearanceSettings, (view) => assert.ok(view.text().includes("字体平滑")));
});

/*
 * 平台从 preload 同步读，不等 IPC。
 *
 * 这里的 `system.platform()` 故意永远不回来：只要还有哪一页在等它，第一帧画的就是初值
 * "darwin"——通用页先写着 darwin，回包之后才改口。
 */
const neverAnswers = () => new Promise<string>(() => {});

function windowsHost() {
	withPlatform("win32", {
		system: { platform: neverAnswers, openTargets: async () => [], openExternal: async () => {} },
		settings: { layers: async () => null },
	});
}

test("通用页第一帧写的就是这台机器的平台", async () => {
	windowsHost();
	await look(GeneralSettings, (view) => {
		assert.ok(view.text().includes("win32"), "GeneralSettings 第一帧应写 win32");
		assert.ok(!view.text().includes("darwin"));
	});
});
