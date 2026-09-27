/**
 * The code font menu: that every preset is a usable stack, and that a stored value maps back to
 * the entry it came from.
 *
 * The setting has always been a CSS font stack and has to stay one — the first choice may not be
 * installed and something must catch that. What the menu removes is having to type one by hand.
 * These hold the two things that would break it quietly: a preset that is not a valid stack, and a
 * round trip that fails to recognise its own value so the menu shows 「自定义」 for a font the user
 * picked from the list.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { CODE_FONTS, matchCodeFont } from "../src/features/settings/code-fonts.ts";

test("every preset ends in a generic family", () => {
	for (const font of CODE_FONTS) {
		assert.match(
			font.stack,
			/monospace$/,
			`${font.label} 的字体栈最后必须落到 monospace——装不上时得有退路`,
		);
	}
});

test("every preset leads with the face it is named after", () => {
	for (const font of CODE_FONTS) {
		const first = font.stack.split(",")[0]!.trim().replace(/^"|"$/g, "");
		assert.equal(first, font.family, `${font.label} 的首选族要和菜单显示的一致`);
	}
});

test("a stored stack maps back to the entry it came from", () => {
	for (const font of CODE_FONTS) {
		assert.equal(matchCodeFont(font.stack)?.label, font.label);
	}
	// Whitespace from a hand-edited settings file should not lose the match.
	assert.equal(matchCodeFont(`  ${CODE_FONTS[0]!.stack}  `)?.label, CODE_FONTS[0]!.label);
});

test("a hand-written stack is reported as custom rather than mis-matched", () => {
	assert.equal(matchCodeFont('"Comic Mono", monospace'), null);
});

test("names are unique, or the menu would have two rows that look the same", () => {
	const labels = CODE_FONTS.map((f) => f.label);
	assert.equal(new Set(labels).size, labels.length);
});
