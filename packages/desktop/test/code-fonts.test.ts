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
import { CODE_FONTS, codeFontMenu, matchCodeFont, type CodeFontOption } from "../src/features/settings/code-fonts.ts";

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

test("a face picked from the installed list is recognised from its stack alone", () => {
	// Before the list comes back, or after the face is uninstalled, the menu must not fall to 自定义.
	const stack = '"Maple Mono NF CN", ui-monospace, Menlo, "PingFang SC", monospace';
	const match = matchCodeFont(stack);
	assert.equal(match?.label, "Maple Mono NF CN");
	assert.equal(match?.stack, stack);
});

test("a preset stays the preset when its stack has the installed shape", () => {
	// JetBrains Mono's preset is that same shape; the row must be the preset, not a lookalike.
	const preset = CODE_FONTS.find((font) => font.family === "JetBrains Mono")!;
	assert.equal(matchCodeFont(preset.stack), preset);
});

/*
 * 菜单只列这台机器有的字体。Windows 上 SF Mono、Menlo、Monaco 三行画出来都是 Consolas；
 * 正在用的那个即使没装也要留着，不然按钮上显示的就不是你在看的字体。
 */
test("the menu offers installed presets, the other installed faces, and the one in use", () => {
	const windows = { families: new Set(["Consolas", "Cascadia Mono"]), extra: [matchCodeFont('"Cascadia Mono", ui-monospace, Menlo, "PingFang SC", monospace')!] };
	const listed = (current: CodeFontOption | null) => codeFontMenu(windows, current).map((font) => font.family);
	assert.deepEqual(listed(null), ["ui-monospace", "Consolas", "Cascadia Mono"]);
	const menlo = CODE_FONTS.find((font) => font.family === "Menlo")!;
	assert.deepEqual(listed(menlo), ["ui-monospace", "Menlo", "Consolas", "Cascadia Mono"], "picked on a Mac, still the selected row here");
	// Without the list nothing is known to be missing, so nothing is hidden.
	assert.equal(codeFontMenu(null, null).length, CODE_FONTS.length);
});
