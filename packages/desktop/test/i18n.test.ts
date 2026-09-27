import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveUiLocale } from "../src/i18n/locales.ts";
import { MESSAGE_CATALOGS, type MessageKey, type PluralForms } from "../src/i18n/messages/index.ts";

test("system languages resolve by BCP 47 family, with every Chinese region on simplified Chinese", () => {
	assert.equal(resolveUiLocale("system", ["zh-Hant-HK"]), "zh-CN");
	assert.equal(resolveUiLocale("system", ["zh-CN"]), "zh-CN");
	assert.equal(resolveUiLocale("system", ["en-GB"]), "en");
	assert.equal(resolveUiLocale("system", ["ja-JP", "zh-CN"]), "zh-CN");
	assert.equal(resolveUiLocale("system", ["es-MX"]), "en");
});

test("an explicit interface language is stable regardless of the operating system", () => {
	assert.equal(resolveUiLocale("en", ["zh-CN"]), "en");
	assert.equal(resolveUiLocale("zh-CN", ["en-US"]), "zh-CN");
});

test("all bundled language packs cover the same interface keys", () => {
	const source = Object.keys(MESSAGE_CATALOGS["zh-CN"]).sort();
	for (const [locale, catalog] of Object.entries(MESSAGE_CATALOGS)) {
		assert.deepEqual(Object.keys(catalog).sort(), source, `${locale} 缺少界面文案`);
	}
});

test("no message spells a character as an HTML reference", () => {
	/*
	 * 文案是当文本塞进界面的，React 不解 HTML 实体：`&#10;` 就是屏幕上的五个字符。个性化页那个
	 * 输入框的示例规则七种语言都这么写过换行，占位符里于是整段挤成一行、夹着一串 `&#10;`。
	 * 要换行就写 `\n`——原生 textarea 的占位符认它。
	 */
	for (const [locale, catalog] of Object.entries(MESSAGE_CATALOGS)) {
		for (const [key, entry] of Object.entries(catalog)) {
			for (const text of forms(entry)) assert.doesNotMatch(text, /&(#\d+|#x[\da-f]+|[a-z]+);/i, `${locale} ${key}`);
		}
	}
});

/** Every sentence an entry can say: the string itself, or each of its plural forms. */
function forms(entry: string | PluralForms): string[] {
	return typeof entry === "string" ? [entry] : Object.values(entry).filter((text): text is string => typeof text === "string");
}

test("English plural forms give one and other, with the same slots as the source", () => {
	const slots = (text: string) => [...new Set(Array.from(text.matchAll(/\{(\w+)\}/g), (match) => match[1]))].sort();
	for (const [key, entry] of Object.entries(MESSAGE_CATALOGS.en)) {
		if (typeof entry === "string") continue;
		assert.ok(entry.one && entry.other, `en ${key} 缺少 one 或 other`);
		const source = slots(MESSAGE_CATALOGS["zh-CN"][key as MessageKey] as string);
		for (const text of forms(entry)) assert.deepEqual(slots(text), source, `en ${key} 占位符与源句不一致`);
	}
});

test("an English count followed by a plural noun has a singular form", () => {
	/*
	 * "{n} conversations" as a plain string reads "1 conversations". A plain string of that shape
	 * is a missing `one`; the exceptions say why they are not.
	 */
	const exempt: Record<string, string> = {
		"sheet.rowsOf": "only shown once a sheet passes MAX_ROWS, so the total is never 1",
		"ruleTry.intro": "the count is the fixed RECENT_LIMIT",
		"ruleTry.noHits": "“matches” is the verb here",
	};
	const missing = Object.entries(MESSAGE_CATALOGS.en).filter(
		([key, entry]) => typeof entry === "string" && !(key in exempt) && /\{n\} (?:[a-z-]+ )?[a-z-]+(?:s\b|\(s\))/i.test(entry),
	);
	assert.deepEqual(missing.map(([key]) => key), []);
});
