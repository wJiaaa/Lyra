import assert from "node:assert/strict";
import { test } from "node:test";
import { NATIVE_CATALOGS, nativeText, nativeTranslator, resolveNativeLocale, setInterfaceLocaleSource } from "../electron/i18n.ts";
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

test("both native catalogs have the same keys and slots", () => {
	const slots = (text: string) => [...new Set(Array.from(text.matchAll(/\{(\w+)\}/g), (match) => match[1]))].sort();
	const source = NATIVE_CATALOGS["zh-CN"];
	assert.deepEqual(Object.keys(NATIVE_CATALOGS.en).sort(), Object.keys(source).sort());
	for (const [key, text] of Object.entries(NATIVE_CATALOGS.en)) {
		assert.deepEqual(slots(text), slots(source[key as keyof typeof source]), key);
	}
});

test("main-process notices follow the interface language as it is set now", () => {
	let locale: "zh-CN" | "en" = "en";
	setInterfaceLocaleSource(() => locale);
	try {
		assert.equal(nativeText("scheduled.started", { name: "Daily" }), "Scheduled task “Daily” started");
		assert.equal(nativeText("terminal.tab", { n: 2 }), "Terminal 2");
		// A replacer function, so `$&` in a title stays text.
		assert.equal(nativeText("notification.done", { title: "a $& b" }), "“a $& b” finished");
		locale = "zh-CN";
		assert.equal(nativeText("scheduled.started", { name: "Daily" }), "定时任务「Daily」开始运行");
	} finally {
		setInterfaceLocaleSource(() => "zh-CN");
	}
});
