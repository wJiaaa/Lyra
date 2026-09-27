/**
 * 终端配色跟着主题走，而不是停在刚离开的那一个。
 *
 * 配色从文档上读（`dark` 类），文档由 `App` 的 effect 写；终端自己的 effect 先于父组件运行，读到的
 * 是切换前的主题。「跟随系统」下系统变暗时 React 什么也没变，那条 effect 根本不跑。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as h, useEffect } from "react";
import { Terminal } from "@xterm/xterm";
import { DEFAULT_SETTINGS } from "@lyra/core";
import { SessionScope } from "../../src/app/session-scope.tsx";
import { applyAppearance } from "../../src/features/settings/theme.ts";
import { TerminalPane } from "../../src/features/terminal/TerminalPane.tsx";
import { useTerminals } from "../../src/store/terminals.ts";
import { useApp } from "../../src/store/index.ts";
import { mount } from "../helpers/mount.ts";

test("切到深色后，终端背景是深色主题的", async () => {
	Object.defineProperty(globalThis, "CSS", { value: window.CSS, configurable: true });
	const built: Terminal[] = [];
	const stubs: Record<string, unknown> = {
		focus() {},
		reset() {},
		onData: () => ({ dispose() {} }),
		cols: 80,
		rows: 24,
		open(this: Terminal) {
			built.push(this);
		},
	};
	for (const [name, value] of Object.entries(stubs)) Object.defineProperty(Terminal.prototype, name, { value, configurable: true });
	const tabs = [{ id: "shell", title: "shell" }];
	Object.defineProperty(window, "lyra", {
		configurable: true,
		value: {
			terminal: {
				listAll: async () => tabs,
				list: async () => tabs,
				attach: async (id: string) => ({ id, epoch: 1, replay: "" }),
				detach() {},
				onData: () => () => {},
				onExit: () => () => {},
			},
		},
	});
	useTerminals.setState({ tabs, active: "", activeByScope: { scope: "shell" } } as never);
	const light = { ...DEFAULT_SETTINGS.appearance, theme: "light" as const };
	useApp.setState({ settings: { ...DEFAULT_SETTINGS, appearance: light }, workspace: null, meta: null, activeSessionId: "scope" } as never);
	applyAppearance(light);

	// The app's own ordering: the parent writes the theme onto the document in an effect.
	function Parent() {
		const appearance = useApp((s) => s.settings?.appearance);
		useEffect(() => {
			if (appearance) applyAppearance(appearance);
		}, [appearance]);
		return h(TerminalPane);
	}
	const view = await mount(h(SessionScope.Provider, { value: "scope" }, h(Parent)));
	try {
		const terminal = built.at(-1);
		assert.ok(terminal);
		const before = terminal.options.theme?.background;
		await act(async () => useApp.setState({ settings: { ...DEFAULT_SETTINGS, appearance: { ...light, theme: "dark" } } } as never));
		assert.ok(document.documentElement.classList.contains("dark"));
		assert.notEqual(terminal.options.theme?.background, before, "终端还停在浅色");
	} finally {
		await view.unmount();
	}
});
