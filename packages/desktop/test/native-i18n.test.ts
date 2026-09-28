import assert from "node:assert/strict";
import { test } from "node:test";
import { NATIVE_CATALOGS, nativeText, nativeTranslator, resolveNativeLocale, setInterfaceLocaleSource, type NativeLocale } from "../electron/i18n.ts";
import { trayMenu } from "../electron/tray-menu.ts";

/** The `{name}` slots a message fills in, so a translation cannot drop or rename one. */
const slots = (text: string) => [...new Set([...text.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]))].sort();

test("every native language pack has the same keys, all filled in, with the same slots", () => {
	/*
	 * The type makes a missing key a compile error, but `node --test` strips types rather than
	 * checking them, and neither the type nor the compiler looks inside the strings: a slot that a
	 * translation renamed would print as `{title}` in that language only.
	 */
	const source = NATIVE_CATALOGS["zh-CN"];
	for (const [locale, catalog] of Object.entries(NATIVE_CATALOGS)) {
		assert.deepEqual(Object.keys(catalog).sort(), Object.keys(source).sort(), `${locale} keys`);
		for (const [key, text] of Object.entries(catalog)) {
			assert.ok(text.trim(), `${locale} ${key} is empty`);
			assert.deepEqual(slots(text), slots(source[key as keyof typeof source]), `${locale} ${key}`);
		}
	}
});

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
	assert.equal(menu[0].type === "item" ? menu[0].label : "", "Open Plume");
	const last = menu.at(-1);
	assert.equal(last?.type === "item" ? last.label : "", "Quit Plume");
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

test("main-process text follows the interface language, asked again for every message", () => {
	/*
	 * The scheduler, the file operations and the code-host and update clients have no settings of
	 * their own to ask, so they write through `nativeText`. What it must not do is settle on one
	 * language: the setting changes while the app runs, and the very next message has to follow it.
	 */
	let language: NativeLocale = "en";
	setInterfaceLocaleSource(() => language);
	try {
		assert.equal(nativeText("files.exists", { name: "notes.md" }), "“notes.md” already exists");
		language = "zh-CN";
		assert.equal(nativeText("files.exists", { name: "notes.md" }), "「notes.md」已存在");
		language = "en";
		assert.equal(nativeText("scheduled.failed", { name: "Review", reason: "boom" }), "Scheduled task “Review” failed: boom");
	} finally {
		setInterfaceLocaleSource(() => "zh-CN");
	}
});

test("each language joins a reason on with its own punctuation, not with Chinese", () => {
	/*
	 * Punctuation is what is left once every word is translated: while this text was a template
	 * literal, 「：」 and 「（）」 sat between the words of every language. Chinese keeps the
	 * full-width marks; English gets its own.
	 */
	const fullWidth = new Set(["zh-CN"]);
	for (const [locale, catalog] of Object.entries(NATIVE_CATALOGS)) {
		for (const [key, text] of Object.entries(catalog)) {
			if (fullWidth.has(locale)) {
				assert.doesNotMatch(text, /\}\s*:|:\s*\{|\(\{|\}\)/, `${locale} ${key} puts a half-width mark beside a slot: ${text}`);
			} else {
				assert.doesNotMatch(text, /[：（），、。；！？]/, `${locale} ${key} carries Chinese punctuation: ${text}`);
			}
		}
	}

	const joined = (locale: NativeLocale) => nativeTranslator(locale, "en")("forge.withDetail", { message: "M", detail: "D" });
	assert.deepEqual(
		(["zh-CN", "en"] as const).map(joined),
		["M：D", "M: D"],
	);
	assert.equal(nativeTranslator("zh-CN", "en")("forge.serverError", { status: 502 }), "对方服务出错了（502）");
	assert.equal(nativeTranslator("en", "en")("forge.serverError", { status: 502 }), "The host's service ran into an error (502)");
});
