/**
 * 圆角和阴影在组件里也只从 token 来。
 *
 * 样式表那一半由 stylelint 守（`stylelint.config.mjs`）；类名写在 tsx 里，stylelint 看不见，oxlint 也
 * 不查类名，所以这里扫源码。收口之前组件里有 22 种圆角、12 种手写阴影，10、11、13、14px 并排出现，
 * 没有一个是有意不同的——见 `docs/architecture/design-system.md`。
 *
 * 放过的：Tailwind 自带的刻度（`rounded-lg`、`shadow-md`）、tokens.css 里的几档（`shadow-menu`、
 * `rounded-[var(--radius-item)]`），以及按尺寸比例算出来的圆角（插件图标的 `size * 0.235`）——那是
 * 一个公式，不是又一档。
 */

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

const SRC = new URL("../src/", import.meta.url).pathname;

const RULES: { name: string; pattern: RegExp }[] = [
	// `rounded-[10px]`、`rounded-tl-[6px]`：手写的一档。`rounded-[var(--radius-item)]` 不算。
	{ name: "手写圆角", pattern: /\brounded(?:-[trblxyse]{1,2})?-\[(?!var\()[^\]]+\]/g },
	// 任何 `shadow-[…]`：描边用 `ring-1`，投影用 `shadow-*` 的那几档。
	{ name: "手写阴影", pattern: /\bshadow-\[[^\]]+\]/g },
	// CodeMirror 主题、内联 style 里写死的像素圆角。
	{ name: "内联像素圆角", pattern: /borderRadius:\s*["'`]\d+(?:\.\d+)?px["'`]/g },
];

async function sources(): Promise<string[]> {
	const entries = await readdir(SRC, { recursive: true });
	return entries.filter((path) => /\.(ts|tsx)$/.test(path)).map((path) => join(SRC, path));
}

test("组件里的圆角和阴影都来自 token", async () => {
	const found: string[] = [];
	for (const file of await sources()) {
		const text = await readFile(file, "utf8");
		for (const { name, pattern } of RULES) {
			for (const match of text.matchAll(pattern)) {
				const line = text.slice(0, match.index).split("\n").length;
				found.push(`${name}  ${file.slice(SRC.length)}:${line}  ${match[0]}`);
			}
		}
	}
	assert.deepEqual(found, [], `改用 Tailwind 刻度或 tokens.css 里的 --radius-* / --shadow-*：\n${found.join("\n")}`);
});

test("规则本身会失败", () => {
	// 一条不会失败的规则比没有规则更糟（ADR-0015）。
	const hits = (text: string) => RULES.flatMap(({ pattern }) => [...text.matchAll(pattern)].map((m) => m[0]));
	assert.deepEqual(hits('className="rounded-[10px] rounded-tl-[6px] shadow-[0_2px_4px_rgba(0,0,0,0.1)]"'), [
		"rounded-[10px]",
		"rounded-tl-[6px]",
		"shadow-[0_2px_4px_rgba(0,0,0,0.1)]",
	]);
	assert.deepEqual(hits('{ borderRadius: "7px" }'), ['borderRadius: "7px"']);
	assert.deepEqual(hits('className="rounded-lg rounded-[var(--radius-item)] shadow-menu ring-1" style={{ borderRadius: radius }}'), []);
});
