/**
 * 打开一个文件落在哪一格：每个文件是顶上的一个标签，面板里不再有一排子标签。
 *
 * 标签页排法下，已经开着它的那格切过去，空着的那格先用上，都没有就新开一格；分栏排法下没有那排
 * 标签，换掉正在看的那一格里的文件，不把屏越劈越碎。
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
const layout = (panelLayout: "tabs" | "split") => useApp.setState({ settings: { appearance: { panelLayout } } } as never);
const previousSettings = useApp.getState().settings;

beforeEach(() => {
	Reflect.set(window, "plume", { files: { read: async (path: string) => ({ text: path, truncated: false }) } });
	window.localStorage.clear();
	useOpenFile.getState().clear();
	usePaneDock.setState({ trees: {}, sizes: {}, drag: null, maximized: {}, focused: {}, crossRatio: {}, host: null });
	usePaneDock.getState().rememberSize("s", { width: 1200, height: 900 });
	provideScope(() => "s");
});

afterEach(() => {
	useApp.setState({ settings: previousSettings });
	provideScope(() => null);
	Reflect.deleteProperty(window, "plume");
});

test("标签页：一个文件一个标签，开过的切回去，不重复开", async () => {
	layout("tabs");
	await openFilePane({ path: "/repo/a.ts", name: "a.ts" });
	await openFilePane({ path: "/repo/b.ts", name: "b.ts" });
	const [first, second] = fileTabs();
	assert.equal(fileTabs().length, 2);
	assert.equal(first, "file");
	assert.equal(shown(first!), "/repo/a.ts");
	assert.equal(shown(second!), "/repo/b.ts");

	await openFilePane({ path: "/repo/a.ts", name: "a.ts" });
	assert.equal(fileTabs().length, 2, "a.ts 已经有一个标签了");
	assert.equal(usePaneDock.getState().tab.s, "file", "切到开着 a.ts 的那个标签");
});

test("标签页：从「+」开出来还空着的那格先用上", async () => {
	layout("tabs");
	usePaneDock.getState().open("s", "file");
	await openFilePane({ path: "/repo/a.ts", name: "a.ts" });
	assert.deepEqual(fileTabs(), ["file"]);
	assert.equal(shown("file"), "/repo/a.ts");
});

test("分栏：换掉正在看的那一格里的文件，不再劈出一格", async () => {
	layout("split");
	await openFilePane({ path: "/repo/a.ts", name: "a.ts" });
	await openFilePane({ path: "/repo/b.ts", name: "b.ts" });
	assert.deepEqual(fileTabs(), ["file"]);
	assert.equal(shown("file"), "/repo/b.ts");
});
