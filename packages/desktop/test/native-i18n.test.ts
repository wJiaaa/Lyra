import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeTranslator, resolveNativeLocale } from "../electron/i18n.ts";
import { trayMenu } from "../electron/tray-menu.ts";

test("native surfaces resolve system locale with the same Chinese region rules", () => {
	assert.equal(resolveNativeLocale("system", "zh-Hant-HK"), "zh-CN");
	assert.equal(resolveNativeLocale("system", "fr-CA"), "en");
	assert.equal(resolveNativeLocale("system", "es-MX"), "en");
	assert.equal(resolveNativeLocale("zh-CN", "en-US"), "zh-CN");
});

test("native dialogs use the selected language", () => {
	assert.equal(nativeTranslator("en", "zh-CN")("dialog.projectDirectory"), "Choose project folder");
	assert.equal(nativeTranslator("zh-CN", "en-US")("dialog.screenshotDirectory"), "选择截图保存位置");
});

test("tray menu labels use the selected language", () => {
	const menu = trayMenu({ windowVisible: false, recent: [], launchAtLogin: false, locale: "en" });
	assert.equal(menu[0].type === "item" ? menu[0].label : "", "Open Lyra");
	const last = menu.at(-1);
	assert.equal(last?.type === "item" ? last.label : "", "Quit Lyra");
});
