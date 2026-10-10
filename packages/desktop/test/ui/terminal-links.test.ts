/**
 * 终端里哪些字是能点开的文件路径。
 *
 * 认多了，一句话里的 `index.ts` 也成了链接；认少了，编译器报的 `src/a.ts:12:3` 点不开——这件事的
 * 全部价值就在后一种。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { ILink, Terminal } from "@xterm/xterm";
import { fileLinks, opensLink, pathsIn } from "../../src/features/terminal/links.ts";

const paths = (text: string) => pathsIn(text).map(({ path, line }) => (line ? `${path}@${line}` : path));

test("what compilers, test runners and stack traces print is found, with its line", () => {
	assert.deepEqual(paths("src/app.ts:42:7 - error TS2322"), ["src/app.ts@42"]);
	assert.deepEqual(paths("  at run (/Users/me/p/lib/run.js:10:5)"), ["/Users/me/p/lib/run.js@10"]);
	assert.deepEqual(paths("./scripts/build.mjs"), ["./scripts/build.mjs"]);
	assert.deepEqual(paths("../shared/a.ts"), ["../shared/a.ts"]);
	assert.deepEqual(paths("C:\\proj\\src\\Program.cs(12,3): error"), ["C:\\proj\\src\\Program.cs@12"]);
	assert.deepEqual(paths("main.go:9: undefined: x"), ["main.go@9"]);
	assert.deepEqual(paths("M  src/a.ts\n?? docs/b.md"), ["src/a.ts", "docs/b.md"]);
});

test("prose, directories and URLs are not file links", () => {
	assert.deepEqual(paths("edit index.ts and run it"), [], "a bare name without a line is a word");
	assert.deepEqual(paths("cd src/components"), [], "no extension: a directory");
	assert.deepEqual(paths("open https://example.com/a/b.html now"), [], "the address's own link handles it");
	assert.deepEqual(paths("v1.2.3"), []);
});

test("the underline starts where the path does", () => {
	const [match] = pathsIn("error: src/a.ts:3");
	assert.equal(match?.start, 7);
	assert.equal(match?.text, "src/a.ts:3");
});

test("⌘-click on a Mac, Ctrl-click elsewhere; a plain click starts a selection", () => {
	const click = (init: MouseEventInit) => new MouseEvent("click", init);
	assert.equal(opensLink(click({ metaKey: true }), "MacIntel"), true);
	assert.equal(opensLink(click({ ctrlKey: true }), "MacIntel"), false);
	assert.equal(opensLink(click({ ctrlKey: true }), "Win32"), true);
	assert.equal(opensLink(click({}), "Win32"), false);
});

/** 一行字的终端：链接提供者只读 `buffer.active.getLine`。 */
function oneLine(text: string): Terminal {
	const cell = (x: number) => ({ getWidth: () => 1, getChars: () => text[x] ?? "" });
	return { buffer: { active: { getLine: () => ({ length: text.length, getCell: cell }) } } } as unknown as Terminal;
}

test("a relative path the project root does not have is looked for in the project, as a reply's link is; two of a name, no link", async () => {
	const opened: string[] = [];
	const asked: string[] = [];
	const provider = fileLinks(oneLine("src/a.ts:3:1 error  scripts/x.mjs  util.ts:9"), {
		base: () => "/repo",
		exists: async () => false,
		locate: async (relative) => {
			asked.push(relative);
			return relative === "src/a.ts" ? "/repo/packages/desktop/src/a.ts" : null;
		},
		openUrl: () => {},
		openFile: (path) => opened.push(path),
	});
	const links = await new Promise<ILink[] | undefined>((resolve) => provider.provideLinks(1, resolve));
	assert.deepEqual(asked, ["src/a.ts", "scripts/x.mjs", "util.ts"]);
	assert.deepEqual(links?.map((link) => link.text), ["src/a.ts:3:1"]);
	links?.[0]?.activate(new MouseEvent("click", { metaKey: true, ctrlKey: true }), "src/a.ts:3:1");
	assert.deepEqual(opened, ["/repo/packages/desktop/src/a.ts"]);
});
