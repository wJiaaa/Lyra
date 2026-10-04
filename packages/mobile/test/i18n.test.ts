import assert from "node:assert/strict";
import { test } from "node:test";
import { MOBILE_LOCALES, mobileTranslator, resolveMobileLocale } from "../src/i18n.ts";

test("mobile locale resolution follows BCP 47 language families", () => {
	assert.equal(resolveMobileLocale("zh-Hant-HK"), "zh-CN");
	assert.equal(resolveMobileLocale("zh_Hans_SG"), "zh-CN");
	assert.equal(resolveMobileLocale("en-GB"), "en");
	assert.equal(resolveMobileLocale("fr-CA"), "en");
});

test("every mobile locale exposes translated shell copy", () => {
	for (const locale of MOBILE_LOCALES) {
		const t = mobileTranslator(locale);
		assert.ok(t("home.title").trim().length > 0, locale);
		assert.ok(t("pair.connect").trim().length > 0, locale);
		assert.ok(t("desk.retry").trim().length > 0, locale);
	}
});

test("mobile translations preserve and interpolate variables", () => {
	const t = mobileTranslator("en-US");
	assert.equal(t("desk.response", { status: 503 }), "Desktop returned 503");
	assert.equal(t("pair.directFailed", { address: "192.168.1.8" }).includes("192.168.1.8"), true);
});
