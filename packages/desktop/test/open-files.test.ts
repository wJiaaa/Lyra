/**
 * 每格文件面板各看各的文件：改名、删除跟着每一格走，关掉一格只放下它自己的。
 */

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

const reads: string[] = [];
(globalThis as unknown as { window: unknown }).window = {
	lyra: {
		files: {
			read: async (path: string) => {
				reads.push(path);
				return { text: path, truncated: false };
			},
		},
	},
};

const { fileSlot, openFileOf, useOpenFile } = await import("../src/store/openFile.ts");

const first = fileSlot("s", "file");
const second = fileSlot("s", "file:k1");
const shown = (slot: string) => openFileOf(useOpenFile.getState(), slot).path;

beforeEach(() => {
	reads.length = 0;
	useOpenFile.getState().clear();
});

test("两格各开各的，互不顶替", async () => {
	await useOpenFile.getState().open(first, { path: "/repo/a.ts", name: "a.ts" });
	await useOpenFile.getState().open(second, { path: "/repo/b.ts", name: "b.ts" });
	assert.equal(shown(first), "/repo/a.ts");
	assert.equal(shown(second), "/repo/b.ts");
	assert.equal(openFileOf(useOpenFile.getState(), second).contents?.text, "/repo/b.ts");
	assert.equal(useOpenFile.getState().last, "/repo/b.ts");
});

test("改了文件夹的名字，每一格里它下面的文件都跟着换地址", async () => {
	await useOpenFile.getState().open(first, { path: "/repo/src/a.ts", name: "a.ts" });
	await useOpenFile.getState().open(second, { path: "/repo/src/b.ts", name: "b.ts" });
	useOpenFile.getState().moved("/repo/src", "/repo/lib");
	assert.equal(shown(first), "/repo/lib/a.ts");
	assert.equal(shown(second), "/repo/lib/b.ts");
});

test("Windows 上改名，标签叫文件名而不是整条反斜杠路径", async () => {
	await useOpenFile.getState().open(first, { path: "C:\\repo\\a.ts", name: "a.ts" });
	useOpenFile.getState().moved("C:\\repo\\a.ts", "C:\\repo\\b.ts");
	assert.equal(shown(first), "C:\\repo\\b.ts");
	assert.equal(openFileOf(useOpenFile.getState(), first).name, "b.ts");
});

test("删掉的文件只让看着它的那一格空下来；关掉一格只放下它自己的", async () => {
	await useOpenFile.getState().open(first, { path: "/repo/a.ts", name: "a.ts" });
	await useOpenFile.getState().open(second, { path: "/repo/b.ts", name: "b.ts" });
	useOpenFile.getState().removed(["/repo/a.ts"]);
	assert.equal(shown(first), null);
	assert.equal(shown(second), "/repo/b.ts");
	useOpenFile.getState().drop(second);
	assert.equal(shown(second), null);
	assert.deepEqual(Object.keys(useOpenFile.getState().files), [first]);
});
