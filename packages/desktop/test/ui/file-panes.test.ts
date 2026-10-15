/**
 * 打开一个文件落在哪一格：每个文件是顶上的一个标签，面板里不再有一排子标签。
 *
 * 已经开着它的那格切过去，空着的那格先用上，都没有就新开一格。
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { openFilePane, provideScope } from "../../src/features/dock/popout.ts";
import { usePaneDock } from "../../src/features/dock/pane-store.ts";
import { kinds } from "../../src/features/dock/tree.ts";
import { fileSlot, openFileOf, useOpenFile } from "../../src/store/openFile.ts";
import { useApp } from "../../src/store/index.ts";

const fileTabs = () => kinds(usePaneDock.getState().tree("s")).filter((kind) => kind === "file" || kind.startsWith("file:"));
const shown = (kind: string) => openFileOf(useOpenFile.getState(), fileSlot("s", kind)).path;

beforeEach(() => {
	Reflect.set(window, "plume", { files: { read: async (path: string) => ({ text: path, truncated: false }) } });
	window.localStorage.clear();
	useOpenFile.getState().clear();
	usePaneDock.setState({ trees: {}, sizes: {}, maximized: {}, focused: {}, host: null });
	usePaneDock.getState().rememberSize("s", { width: 1200, height: 900 });
	provideScope(() => "s");
});

afterEach(() => {
	provideScope(() => null);
	Reflect.deleteProperty(window, "plume");
});

test("一个文件一个标签，开过的切回去，不重复开", async () => {
	await openFilePane("/repo/a.ts");
	await openFilePane("/repo/b.ts");
	const [first, second] = fileTabs();
	assert.equal(fileTabs().length, 2);
	assert.equal(first, "file");
	assert.equal(shown(first!), "/repo/a.ts");
	assert.equal(shown(second!), "/repo/b.ts");

	await openFilePane("/repo/a.ts");
	assert.equal(fileTabs().length, 2, "a.ts 已经有一个标签了");
	assert.equal(usePaneDock.getState().tab.s, "file", "切到开着 a.ts 的那个标签");
});

test("读不到的文件不开出空标签，说一声读的是哪儿；开着的那格照旧", async () => {
	Reflect.set(window, "plume", { files: { read: async (path: string) => (path.endsWith("missing.mjs") ? null : { text: path, truncated: false }) } });
	useApp.setState({ notices: [] });
	await openFilePane("/repo/a.ts");
	await openFilePane("/repo/missing.mjs");
	assert.deepEqual(fileTabs(), ["file"]);
	assert.equal(shown("file"), "/repo/a.ts");
	assert.equal(openFileOf(useOpenFile.getState(), fileSlot("s", "file")).loading, false);
	assert.match(useApp.getState().notices.at(-1)?.message ?? "", /\/repo\/missing\.mjs/);
});

test("读文件的调用本身失败了，也是一句读不到，不往外抛", async () => {
	Reflect.set(window, "plume", { files: { read: async () => { throw new Error("ipc gone"); } } });
	useApp.setState({ notices: [] });
	await openFilePane("/repo/a.ts");
	assert.deepEqual(fileTabs(), []);
	assert.match(useApp.getState().notices.at(-1)?.message ?? "", /\/repo\/a\.ts/);
});

test("标签叫磁盘上的文件名", async () => {
	await openFilePane("/repo/docs/说明.md");
	assert.equal(openFileOf(useOpenFile.getState(), fileSlot("s", "file")).name, "说明.md");
});

test("从「+」开出来还空着的那格先用上", async () => {
	usePaneDock.getState().open("s", "file");
	await openFilePane("/repo/a.ts");
	assert.deepEqual(fileTabs(), ["file"]);
	assert.equal(shown("file"), "/repo/a.ts");
});

test("同一个 Windows 文件换三种写法，只开一个标签，用系统的写法", async () => {
	await openFilePane("C:/plume/app/README.md");
	await openFilePane("C:\\plume\\app\\README.md");
	await openFilePane("c:/plume/app/README.md");
	assert.deepEqual(fileTabs(), ["file"]);
	assert.equal(shown("file"), "C:\\plume\\app\\README.md");
});

test("macOS 和 Linux 上大小写不同就是两个文件", async () => {
	await openFilePane("/work/App/a.md");
	await openFilePane("/work/app/a.md");
	assert.equal(fileTabs().length, 2);
});
