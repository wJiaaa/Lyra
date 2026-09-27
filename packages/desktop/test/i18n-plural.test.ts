/**
 * Which form of a counting sentence a number picks. `translateIn` is what both `translate` and
 * `useI18n().t` call, so reading a real entry through it covers both paths.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { PluralForms } from "../src/i18n/messages/index.ts";
import { pluralForm } from "../src/i18n/plural.ts";
import { setActiveLocale, translate, translateIn } from "../src/i18n/translate.ts";

test("English says 1 conversation and 0 or 2 conversations", () => {
	assert.equal(translateIn("en", "archived.chatCount", { n: 1 }), "1 conversation");
	assert.equal(translateIn("en", "archived.chatCount", { n: 0 }), "0 conversations");
	assert.equal(translateIn("en", "archived.chatCount", { n: 2 }), "2 conversations");
	assert.equal(translateIn("en", "storage.sizeAndCount", { size: "3 MB", n: 1 }), "3 MB · 1 conversation");
	assert.equal(translateIn("en", "sync.behindBy", { n: 1 }), "1 commit behind");
	assert.equal(translateIn("en", "sync.behindBy", { n: 3 }), "3 commits behind");
});

test("Chinese says the same sentence for every count", () => {
	assert.equal(translateIn("zh-CN", "archived.chatCount", { n: 1 }), "1 个聊天");
	assert.equal(translateIn("zh-CN", "archived.chatCount", { n: 2 }), "2 个聊天");
});

test("a count passed as digits still picks its form; a formatted one takes other", () => {
	const forms: PluralForms = { one: "{n} message", other: "{n} messages" };
	assert.equal(pluralForm("en", forms, "1"), "{n} message");
	assert.equal(pluralForm("en", forms, "1,234"), "{n} messages");
	assert.equal(pluralForm("en", forms, undefined), "{n} messages");
	assert.equal(pluralForm("en", "a plain string", 1), "a plain string");
});

test("translate picks the form for the language the window is set to", () => {
	try {
		setActiveLocale("en");
		assert.equal(translate("archived.chatCount", { n: 1 }), "1 conversation");
	} finally {
		setActiveLocale("zh-CN");
	}
});
