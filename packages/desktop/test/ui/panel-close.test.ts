/**
 * 右栏的标签就是浏览器标签页：关了就是没了，哪一格、从哪儿关都一样。
 *
 * 从前最早那一格（`chat`、`terminal`、`file`、浏览器）关掉只算收起，东西留着，重开又冒出来；弹出去
 * 的那一格被人关掉窗口时什么也不收。这里把两条出路和几种面板各自放掉的东西钉住。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { MessageCirclePlus } from "lucide-react";
import { closeNow, usePaneDock } from "../../src/features/dock/pane-store.ts";
import { popOutPanel, provideScope, usePanelWindows, watchPanelWindows } from "../../src/features/dock/popout.ts";
import { registerPanels } from "../../src/features/dock/panels/registry.ts";
import { closeTerminal } from "../../src/features/terminal/TerminalTitle.tsx";
import { closeBrowser } from "../../src/features/browser/browser-store.ts";
import { useTerminals } from "../../src/store/terminals.ts";

function reset() {
	window.localStorage.clear();
	usePaneDock.setState({ trees: {}, sizes: {}, maximized: {}, focused: {}, tab: {}, host: null });
	usePanelWindows.setState({ panels: [], opening: [] });
	provideScope(() => "s");
}

/** 一个只记下「谁被关了」的面板，顶替同 kind 的内置那一项。 */
function recording(kind: "terminal" | "chat") {
	const released: string[][] = [];
	const unregister = registerPanels([{ kind, label: "dock.sideChat", icon: MessageCirclePlus, shortcut: "", render: () => null,
		onClose: (scope, closed) => void released.push([scope, closed]) }]);
	return { released, unregister };
}

test("最早那一格和后开的那几格关掉一样：都放掉自己的东西", () => {
	reset();
	const { released, unregister } = recording("terminal");
	try {
		usePaneDock.getState().open("s", "terminal");
		usePaneDock.getState().open("s", "terminal:abc");
		closeNow("s", "terminal:abc");
		closeNow("s", "terminal");
		assert.deepEqual(released, [["s", "terminal:abc"], ["s", "terminal"]]);
	} finally { unregister(); }
});

test("人关掉弹出去的窗口和点 ✕ 一样放掉；「收回」只是挪回来，不放", async () => {
	reset();
	const { released, unregister } = recording("chat");
	let changed = (_state: { panels: { kind: string; scope: string }[] }) => {};
	let restore = (_input: { kind: string; scope: string }) => {};
	Reflect.set(window, "plume", { windows: {
		list: async () => ({ panels: [] }),
		onChanged: (listener: typeof changed) => { changed = listener; return () => {}; },
		onRestorePanel: (listener: typeof restore) => { restore = listener; return () => {}; },
		openPanel: async () => ({ ok: true }),
		closePanel: async () => ({ ok: true }),
	} });
	const stop = watchPanelWindows();
	try {
		await new Promise((resolve) => setTimeout(resolve, 0));
		usePaneDock.getState().rememberSize("s", { width: 1200, height: 800 });

		// 弹出去，再收回来：东西还在。
		usePaneDock.getState().open("s", "chat");
		assert.equal(await popOutPanel({ scope: "s", kind: "chat", sessionId: "s" }), true);
		changed({ panels: [{ kind: "chat", scope: "s" }] });
		restore({ kind: "chat", scope: "s" });
		await new Promise((resolve) => setTimeout(resolve, 0));
		changed({ panels: [] });
		assert.deepEqual(released, [], "收回不是关");

		// 再弹出去，这次人直接关掉那个窗口。
		assert.equal(await popOutPanel({ scope: "s", kind: "chat", sessionId: "s" }), true);
		changed({ panels: [{ kind: "chat", scope: "s" }] });
		changed({ panels: [] });
		assert.deepEqual(released, [["s", "chat"]]);
		assert.equal(window.localStorage.getItem("dw:homes")?.includes("s:chat") ?? false, false, "关掉了，下次启动不会自己回来");
	} finally {
		stop();
		unregister();
	}
});

test("最早那一格终端关掉，它的 shell 也结束——包括在弹出窗口里换过的那个", () => {
	const killed: string[] = [];
	Reflect.set(window, "plume", { terminal: { kill: (id: string) => void killed.push(id) } });
	window.localStorage.clear();
	useTerminals.setState({ tabs: [{ id: "t1", title: "zsh" }], active: "", activeByScope: { s: "t1" } });
	closeTerminal("s", "terminal");
	assert.deepEqual(killed, ["t1"]);
	assert.equal(useTerminals.getState().tabs.length, 0);
	assert.equal(useTerminals.getState().activeByScope.s, undefined);

	// 这个窗口的 store 不知道，只有两边共用的那条记录知道。
	window.localStorage.setItem("ly:terminal-selection:s#x1", "t9");
	closeTerminal("s", "terminal:x1");
	assert.deepEqual(killed, ["t1", "t9"]);
	assert.equal(window.localStorage.getItem("ly:terminal-selection:s#x1"), null);
});

test("关掉一个网页标签只关这一页：同一会话别的网页、agent 在后台开着的都不动", () => {
	const closed: string[] = [];
	Reflect.set(window, "plume", { browser: { command: async (command: { id: string }) => { closed.push(command.id); return { tabs: [], activeId: null }; } } });
	closeBrowser("s", "browser:mine");
	assert.deepEqual(closed, ["mine"]);
	closeBrowser("s", "browser");
	assert.deepEqual(closed, ["mine"], "旧版存下来的那一格不是哪一页");
});
