/**
 * The contract against the files it describes: the preload that exposes it and the main process
 * that answers it.
 *
 * Read as text rather than imported. Importing `preload.ts` would pull in `electron`, which does not
 * exist in a plain Node process; and reading the source is the stronger check anyway — it asserts
 * against what is written, not against what a module happens to export.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { CHANNELS, METHODS } from "../src/methods.ts";

const DESKTOP = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "desktop", "electron");

async function source(file: string): Promise<string> {
	return readFile(join(DESKTOP, file), "utf8");
}

/** Every `group.name` in the contract, flat. */
function everyMethod(): string[] {
	return Object.entries(METHODS).flatMap(([group, methods]) => Object.keys(methods).map((name) => `${group}.${name}`));
}

test("preload 是从契约生成的，而不是另抄一份", async () => {
	/*
	 * 这两条测试原本比对的是「契约里的每个 channel 字符串是否出现在 preload 的源码里」，
	 * 反过来也比一次。那在 preload 手写 157 个 `ipcRenderer.invoke("…")` 的时候是对的检查。
	 *
	 * 现在 preload 遍历 `METHODS` 生成它们，源码里一个 channel 字面量都没有——旧的比对方式
	 * 会永远失败，而它要防的问题（两处名字不一致）已经不可能发生了：名字只有一处。
	 *
	 * 于是改为检查那个前提本身还成立：preload 确实在读契约，并且没有偷偷写死 channel。
	 */
	const preload = await source("preload.ts");

	assert.match(preload, /from "@lyra\/contract"/, "preload 必须从契约读方法表");
	assert.match(preload, /Object\.entries\(METHODS\)/, "并且是遍历它来生成 invoke");

	/*
	 * 手写的 channel 字面量。
	 *
	 * 事件订阅仍然是手写的（`ipcRenderer.on("terminal:data", …)`），那是有意的——推送不在
	 * `METHODS` 里。所以这里只挑 `invoke` 的调用来看。
	 */
	const hardcoded = [...preload.matchAll(/ipcRenderer\.invoke\("([^"]+)"/g)].map((m) => m[1] as string);
	assert.deepEqual(
		hardcoded,
		[],
		"preload 里出现了写死的 invoke channel——那正是这次改动要消灭的第二处拼写",
	);
});


/**
 * 主进程注册的 channel。
 *
 * 大多是 `ipcMain.handle("git:stat", …)` 这样的字面量；`git.ts` 里有一处是从一张
 * `[["git:stage", stagePaths], …] as const` 的表上循环注册的，所以名字仍是字面量，只是不在
 * `handle(` 后面。两种都收，另外把「channel 是个变量」的调用点数出来——那种形状这套读源码的
 * 检查看不见，允许存在但不允许悄悄变多。
 */
async function registeredChannels(): Promise<{ channels: Set<string>; dynamic: number }> {
	const files = (await readdir(DESKTOP, { recursive: true, withFileTypes: true }))
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
		.map((entry) => join(entry.parentPath, entry.name));

	const channels = new Set<string>();
	let dynamic = 0;
	for (const file of files) {
		const text = await readFile(file, "utf8");
		for (const match of text.matchAll(/ipcMain\.handle(?:Once)?\(\s*"([^"]+)"/g)) channels.add(match[1] as string);
		// `ipcMain.handle(channel, …)` — 名字不在这一行，它在同一文件的表里。
		dynamic += [...text.matchAll(/ipcMain\.handle(?:Once)?\(\s*[A-Za-z_$][\w$]*/g)].length;
		for (const match of text.matchAll(/\[\s*"([a-z]+:[a-zA-Z-]+)"\s*,\s*\w+\s*\]/g)) channels.add(match[1] as string);
	}
	return { channels, dynamic };
}

test("主进程注册的 channel 和契约一一对应", async () => {
	/*
	 * 契约原本只和 `preload.ts` 比对过，真正接电话的那一处从来没人看。两个方向都会坏，坏法
	 * 不一样——
	 *
	 *   契约有、主进程没有 → preload 照样生成一个方法，点下去抛
	 *     `No handler registered for 'x:y'`，而且是点到那个按钮的那一刻才抛
	 *   主进程有、契约没有 → 这个 handler 谁也叫不到，是死代码；或者它绕过了契约
	 *
	 * 现在两个方向都比。
	 */
	const { channels, dynamic } = await registeredChannels();
	const declared = new Set(CHANNELS);

	const unimplemented = CHANNELS.filter((channel) => !channels.has(channel));
	assert.deepEqual(unimplemented, [], "契约声明了但主进程没注册——渲染进程调它会得到「没有 handler」");

	const undeclared = [...channels].filter((channel) => !declared.has(channel));
	assert.deepEqual(undeclared, [], "主进程注册了契约里没有的 channel——它要么是死代码，要么绕过了契约");

	assert.equal(channels.size, CHANNELS.length, "数量也要对上");
	assert.equal(dynamic, 1, "`ipcMain.handle(变量)` 的调用点只有 git.ts 那一处表驱动；多出来的这套检查看不见");
});

test("channel 不重名", () => {
	const seen = new Map<string, string>();
	const clashes: string[] = [];
	for (const [group, methods] of Object.entries(METHODS)) {
		for (const [name, method] of Object.entries(methods)) {
			const previous = seen.get(method.channel);
			if (previous) clashes.push(`${method.channel}: ${previous} 与 ${group}.${name}`);
			else seen.set(method.channel, `${group}.${name}`);
		}
	}
	assert.deepEqual(clashes, [], "两个方法用了同一个 channel，后注册的会覆盖先注册的");
});

test("channel 都是「域:动作」的形状", () => {
	/*
	 * `terminal:list-all` 是唯一一个用短横线的，其余都是 camelCase。
	 *
	 * 不改它：channel 名是进程之间的约定，改名要同时动 preload、handler 与所有调用点，为一处
	 * 命名不齐做这些不值得。列在这里而不是放宽正则，是因为「已知的一处例外」和「随便怎么写都行」
	 * 是两回事——再多一个就该统一了。
	 */
	const KNOWN_ODD = new Set(["terminal:list-all"]);
	const odd = CHANNELS.filter((channel) => !/^[a-z]+:[a-zA-Z]+$/.test(channel) && !KNOWN_ODD.has(channel));
	assert.deepEqual(odd, [], "channel 命名统一成 域:动作，混进别的形状会让按域搜索漏掉");
});

test("数量对得上", () => {
	assert.equal(CHANNELS.length, everyMethod().length, "每个方法一个 channel");
	assert.ok(CHANNELS.length > 100, "这个应用的 IPC 面本来就大，少于一百说明清单丢了东西");
});
