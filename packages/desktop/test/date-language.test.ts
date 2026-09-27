/**
 * Dates follow the interface language instead of always being written the Chinese way.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { conversationTime } from "../src/features/conversation/question-navigation.ts";
import { setActiveLocale } from "../src/i18n/translate.ts";
import { exactTime } from "../src/lib/relative-time.ts";

const at = new Date(2025, 8, 26, 14, 28).getTime();
const now = new Date(2026, 8, 28, 10, 0).getTime();

test("exact and conversation times are written in the interface language", () => {
	try {
		setActiveLocale("en");
		assert.match(exactTime(new Date(at).toISOString()), /^09\/26\/2025, /);
		assert.match(conversationTime(at, now), /^September 26, 2025 /);
		setActiveLocale("zh-CN");
		assert.match(exactTime(new Date(at).toISOString()), /^2025\/09\/26/);
		assert.match(conversationTime(at, now), /^2025年9月26日 14:28$/);
	} finally {
		setActiveLocale("zh-CN");
	}
});
