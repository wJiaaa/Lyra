/**
 * Which form of a counting sentence a number picks. `translateIn` is what both `translate` and
 * `useI18n().t` call, so reading a real entry through it covers both paths.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { PluralForms } from "../src/i18n/messages/index.ts";
import { pluralCategory, pluralForm } from "../src/i18n/plural.ts";
import { setActiveLocale, translate, translateIn } from "../src/i18n/translate.ts";

const categories = (locale: Parameters<typeof pluralCategory>[0], counts: number[]) =>
	counts.map((count) => pluralCategory(locale, count));

test("English says 1 conversation and 0 or 2 conversations", () => {
	assert.deepEqual(categories("en", [1]), ["one"]);
	assert.deepEqual(categories("en", [0, 2, 5, 11, 21, 101, 1.5]), Array(7).fill("other"));

	assert.equal(translateIn("en", "archived.chatCount", { n: 1 }), "1 conversation");
	assert.equal(translateIn("en", "archived.chatCount", { n: 0 }), "0 conversations");
	assert.equal(translateIn("en", "archived.chatCount", { n: 2 }), "2 conversations");
	assert.equal(translateIn("en", "archived.messageCount", { n: 1 }), " · 1 message");
	assert.equal(translateIn("en", "cleanup.confirmSome", { n: 1 }), "Delete 1 conversation?");
	assert.equal(translateIn("en", "cleanup.confirmSome", { n: 21 }), "Delete 21 conversations?");
	assert.equal(translateIn("en", "storage.sizeAndCount", { size: "3 MB", n: 1 }), "3 MB · 1 conversation");
	assert.equal(translateIn("en", "sync.behindBy", { n: 1 }), "1 commit behind");
	assert.equal(translateIn("en", "sync.behindBy", { n: 3 }), "3 commits behind");
});

test("Chinese says the same sentence for every count", () => {
	assert.deepEqual(categories("zh-CN", [0, 1, 2, 5, 21, 1.5]), Array(6).fill("other"));
	assert.equal(translateIn("zh-CN", "archived.chatCount", { n: 1 }), "1 个聊天");
	assert.equal(translateIn("zh-CN", "archived.chatCount", { n: 2 }), "2 个聊天");
});

test("a count passed as digits still picks its form; a formatted one takes other", () => {
	const forms: PluralForms = { one: "{n} message", other: "{n} messages" };
	// `usage.messages` is called with `toLocaleString()`, so this is the path a real "1" takes.
	assert.equal(pluralForm("en", forms, "1"), "{n} message");
	assert.equal(pluralForm("en", forms, "2"), "{n} messages");
	assert.equal(pluralForm("en", forms, "1,234"), "{n} messages");
	assert.equal(pluralForm("en", forms, "1.2K"), "{n} messages");
	assert.equal(pluralForm("en", forms, undefined), "{n} messages");
	assert.equal(pluralForm("en", "a plain string", 1), "a plain string");
	assert.equal(translateIn("en", "usage.messages", { n: "1" }), "1 message");
});

test("a category the entry leaves out falls back to other", () => {
	assert.equal(pluralForm("en", { other: "other" }, 1), "other");
});

test("translate picks the form for the language the window is set to", () => {
	try {
		setActiveLocale("en");
		assert.equal(translate("archived.chatCount", { n: 1 }), "1 conversation");
	} finally {
		setActiveLocale("zh-CN");
	}
});
