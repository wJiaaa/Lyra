/**
 * 一屏开好几格终端：每格是顶上的一个标签，各看各的 shell，没有面板里的子标签。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h } from "react";
import { Terminal } from "@xterm/xterm";
import { PanelKindScope, SessionScope } from "../../src/app/session-scope.tsx";
import { TerminalPane } from "../../src/features/terminal/TerminalPane.tsx";
import { closeTerminal } from "../../src/features/terminal/TerminalTitle.tsx";
import { useTerminals } from "../../src/store/terminals.ts";
import { useApp } from "../../src/store/index.ts";
import { mount } from "../helpers/mount.ts";

test("再开的一格终端起一个新 shell，不接手没人看的那个；关掉它，它的 shell 一起结束", async (t) => {
	const css = Object.getOwnPropertyDescriptor(globalThis, "CSS");
	Object.defineProperty(globalThis, "CSS", { value: window.CSS, configurable: true });
	t.after(() => {
		if (css) Object.defineProperty(globalThis, "CSS", css);
		else Reflect.deleteProperty(globalThis, "CSS");
	});
	const additions = { focus() {}, reset() {}, onData: () => ({ dispose() {} }), cols: 80, rows: 24, options: {} };
	for (const [name, value] of Object.entries(additions)) {
		const original = Object.getOwnPropertyDescriptor(Terminal.prototype, name);
		Object.defineProperty(Terminal.prototype, name, { value, configurable: true });
		t.after(() => {
			if (original) Object.defineProperty(Terminal.prototype, name, original);
			else Reflect.deleteProperty(Terminal.prototype, name);
		});
	}
	// 一个在跑、没人在看的 shell：预热出来的那种，最早那一格会接手它。
	const idle = { id: "idle", title: "终端 1" };
	const opened: string[] = [];
	const killed: string[] = [];
	Reflect.set(window, "lyra", { terminal: {
		listAll: async () => [idle],
		list: async () => [idle],
		open: async () => { const id = `new${opened.length + 1}`; opened.push(id); return { id, title: `终端 ${opened.length + 1}` }; },
		attach: async (id: string) => ({ id, epoch: 1, replay: "" }),
		detach: () => {},
		kill: (id: string) => { killed.push(id); },
		onData: () => () => {},
		onExit: () => () => {},
	} });
	window.localStorage.clear();
	useTerminals.setState({ tabs: [], active: "", activeByScope: {} });
	useApp.setState({ settings: null, workspace: null, meta: null, activeSessionId: "s" });
	const pane = (kind: string) => h(SessionScope.Provider, { value: "s" }, h(PanelKindScope.Provider, { value: kind }, h(TerminalPane)));
	const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

	const first = await mount(pane("terminal"));
	const extra = await mount(pane("terminal:k1"));
	try {
		await settle();
		const chosen = useTerminals.getState().activeByScope;
		assert.equal(chosen.s, "idle", "最早那一格接手没人看的那个");
		assert.equal(chosen["s#k1"], "new1", "再开的那一格是一个新的 shell");
		assert.deepEqual(opened, ["new1"]);

		closeTerminal("s", "k1");
		assert.deepEqual(killed, ["new1"]);
		assert.equal(useTerminals.getState().activeByScope["s#k1"], undefined);
		assert.equal(useTerminals.getState().activeByScope.s, "idle", "别的那格不受影响");
	} finally {
		await extra.unmount();
		await first.unmount();
		Reflect.deleteProperty(window, "lyra");
	}
});
