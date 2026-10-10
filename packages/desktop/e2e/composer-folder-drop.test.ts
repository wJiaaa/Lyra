/**
 * 往会话里拖文件夹，落下的是一枚和文件一样的标记（图标是文件夹），不是一条「无法读取」，也不是一串绝对路径。
 *
 * 文件夹在 `dataTransfer.files` 里也是一个 `File`，最早被当附件去读字节，读失败，弹一条提示，输入框
 * 里什么都没有；后来写成正文里的 `@"/绝对/路径"`，一长串横在输入框里。文件树里拖出来的路径仍是
 * 引用：输入框曾经吞掉了这次 drop，却只看 `files`，而那里是空的。
 *
 * 拖放不必瞄准输入框：拖到会话卡片的任何一处都能放，悬着时盖一层「松开即可添加」。
 *
 * 系统拖放走 `Input.dispatchDragEvent` 带真实路径：只有这样，`webkitGetAsEntry` 和
 * `webUtils.getPathForFile` 答的才是真话——页面里自己拼的 `DataTransfer` 装不进一个文件夹。
 */

import assert from "node:assert/strict";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { startApp, type RunningApp } from "./app.ts";

let app: RunningApp;
let root = "";
let outside = "";

async function seed(home: string): Promise<void> {
	// 项目路径在应用里是解析过链接的那一份（macOS 的临时目录在 `/private` 下），树给出的路径跟着它。
	root = join(await realpath(home), "project");
	outside = join(home, "outside");
	await mkdir(join(root, "src"), { recursive: true });
	await writeFile(join(root, "src", "a.ts"), "export {}\n");
	await mkdir(join(outside, "folderA"), { recursive: true });
	await writeFile(join(outside, "folderA", "x.txt"), "hi\n");
	await writeFile(join(outside, "b.txt"), "hello\n");
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1400, height: 900, x: 0, y: 0 }));
	await writeFile(join(home, "settings.json"), JSON.stringify({
		version: 1, providers: [], mcpServers: [],
		projects: [{ id: "e2e", name: "project", path: root, pinned: true, lastOpenedAt: 1 }],
		defaultModelId: null, permissionMode: "auto", thinking: "medium", retryAttempts: 3,
		hooks: [], scheduledTasks: [], disabledPlugins: [], alwaysAllow: [],
	}));
}

before(async () => {
	app = await startApp({ port: 9742, seed });
});
after(async () => {
	await app?.stop();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const FIELD = `document.querySelector(".ly-composer textarea")`;
const value = () => app.evaluate<string>(`${FIELD}.value`);
const unreadable = () => app.evaluate<boolean>(`document.body.innerText.includes("无法读取")`);
/** 输入框里画成文件夹的那几枚标记，各自写着什么。 */
const folderMarks = () =>
	app.evaluate<string[]>(`[...document.querySelectorAll('.ly-composer .ly-attachment-token[data-kind="folder"]')].map((el) => el.textContent)`);

/** 等某个条件成立，成立不了就把最后一次看到的交给断言去说。 */
async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean, ms = 5_000): Promise<T> {
	const end = Date.now() + ms;
	let seen = await read();
	while (!ok(seen) && Date.now() < end) {
		await sleep(100);
		seen = await read();
	}
	return seen;
}

beforeEach(async () => {
	const ready = await until(() => app.evaluate<boolean>(`!!${FIELD}`), Boolean, 30_000);
	assert.ok(ready, "输入框没出来");
	await app.evaluate(`(() => { const el = ${FIELD}; el.focus(); el.select(); document.execCommand("delete"); })()`);
	await until(value, (text) => text === "");
});

/** 一次真实的系统拖放：Chromium 按路径造出 `File`，文件夹就是文件夹。 */
async function dropFromSystem(paths: string[]): Promise<void> {
	const at = await app.evaluate<{ x: number; y: number }>(
		`(() => { const r = ${FIELD}.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
	);
	const data = { items: [], files: paths, dragOperationsMask: 1 };
	for (const type of ["dragEnter", "dragOver", "drop"]) await app.send("Input.dispatchDragEvent", { type, ...at, data });
}

test("系统里拖进一个文件夹和一个文件：两个都是标记，文件夹画成文件夹，次序不变", async () => {
	await dropFromSystem([join(outside, "folderA"), join(outside, "b.txt")]);
	const text = await until(value, (t) => t.includes("【b.txt】"));
	assert.equal(text.trim(), "【folderA】【b.txt】");
	assert.deepEqual(await until(folderMarks, (marks) => marks.length > 0), ["【folderA】"]);
	assert.equal(await unreadable(), false, "文件夹不该再被当附件去读");
});

test("认不出是不是文件夹时（webkitGetAsEntry 返回 null），读不出字节的那个仍写成引用", async () => {
	await app.evaluate(`(() => {
		window.__entry = DataTransferItem.prototype.webkitGetAsEntry;
		DataTransferItem.prototype.webkitGetAsEntry = () => null;
	})()`);
	try {
		await dropFromSystem([join(outside, "folderA"), join(outside, "b.txt")]);
		const text = await until(value, (t) => t.includes("【b.txt】"));
		assert.equal(text.trim(), "【folderA】【b.txt】");
		assert.deepEqual(await until(folderMarks, (marks) => marks.length > 0), ["【folderA】"]);
		assert.equal(await unreadable(), false, "回退路径上文件夹也不该落成「无法读取」");
	} finally {
		await app.evaluate(`DataTransferItem.prototype.webkitGetAsEntry = window.__entry`);
	}
});

test("从文件树拖一个文件夹进来：写成引用", async () => {
	const opened = await app.evaluate<boolean>(`(async () => {
		const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
		const row = () => [...document.querySelectorAll("[role='treeitem']")].find((el) => el.textContent.trim() === "src");
		if (!row()) {
			const menu = document.querySelector('button[aria-label="面板"]');
			if (menu) { menu.click(); await sleep(250); }
			for (const el of document.querySelectorAll('[role="menuitem"], button')) {
				if (el.textContent && el.textContent.includes("文件") && !el.textContent.includes("内容")) { el.click(); break; }
			}
			for (let i = 0; i < 30 && !row(); i += 1) await sleep(200);
			document.body.click();
		}
		return !!row();
	})()`);
	assert.ok(opened, "文件面板里没找到 src 这一行");

	// 拖出的数据由树自己的 dragstart 写进去，输入框收到的就是它真正会给的那一份。
	await app.evaluate(`(() => {
		const row = [...document.querySelectorAll("[role='treeitem']")].find((el) => el.textContent.trim() === "src");
		const transfer = new DataTransfer();
		row.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: transfer }));
		const field = ${FIELD};
		field.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer }));
		field.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
		row.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: transfer }));
	})()`);
	const text = await until(value, (t) => t.includes("@"));
	assert.equal(text.trim(), `@"${join(root, "src")}"`);
});

test("拖到会话卡片的空处：悬着时盖一层蒙版，松开就收进输入框", async () => {
	const at = await app.evaluate<{ x: number; y: number }>(
		`(() => { const r = document.querySelector("[data-ly-chat-surface]").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + 60 }; })()`,
	);
	assert.equal(await app.evaluate<boolean>(`${FIELD}.closest(".ly-composer").contains(document.elementFromPoint(${at.x}, ${at.y}))`), false, "落点不该在输入框上");
	const data = { items: [], files: [join(outside, "folderA")], dragOperationsMask: 1 };
	await app.send("Input.dispatchDragEvent", { type: "dragEnter", ...at, data });
	await app.send("Input.dispatchDragEvent", { type: "dragOver", ...at, data });
	const shown = await until(
		() => app.evaluate<string | null>(`document.querySelector("[data-ly-drop-overlay]")?.innerText ?? null`),
		(label) => label !== null,
	);
	assert.equal(shown, "松开即可添加");
	await app.send("Input.dispatchDragEvent", { type: "drop", ...at, data });
	assert.equal((await until(value, (t) => t.includes("【folderA】"))).trim(), "【folderA】");
	assert.deepEqual(await until(folderMarks, (marks) => marks.length === 1), ["【folderA】"]);
	assert.equal(await app.evaluate<boolean>(`!!document.querySelector("[data-ly-drop-overlay]")`), false, "放下之后蒙版要撤掉");
});
