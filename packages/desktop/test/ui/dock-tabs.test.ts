import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as h } from "react";
import { Globe, Terminal } from "lucide-react";
import { DEFAULT_SETTINGS } from "@plume/core";
import { DockView } from "../../src/features/dock/DockView.tsx";
import { LayoutProvider } from "../../src/app/layout.tsx";
import { usePaneDock } from "../../src/features/dock/pane-store.ts";
import { registerPanels } from "../../src/features/dock/panels/registry.ts";
import { toggleScopedPanel } from "../../src/features/dock/popout.ts";
import { panelsOf } from "../../src/features/dock/tabs.ts";
import { has } from "../../src/features/dock/tree.ts";
import { useApp } from "../../src/store/index.ts";
import { translate } from "../../src/i18n/translate.ts";
import { click, mount } from "../helpers/mount.ts";

test("tabs layout: every panel stays mounted in one right-hand pane, and only the current tab shows", async () => {
	Object.defineProperty(window, "plume", { configurable: true, value: { platform: "darwin" } });
	window.localStorage.clear();
	useApp.setState({ settings: { ...DEFAULT_SETTINGS} });
	usePaneDock.setState({ trees: {}, sizes: {}, maximized: {}, focused: {}, tab: {}, tabShare: 0.4, host: null });
	const unregister = registerPanels([
		{ kind: "terminal", label: "common.terminal", icon: Terminal, shortcut: "", render: () => h("input", { "data-test-terminal": "" }) },
		{ kind: "browser", label: "browser.title", icon: Globe, shortcut: "", render: () => h("input", { "data-test-browser": "" }) },
	]);
	const scope = "tabs";
	const view = await mount(h(LayoutProvider, { children: h(DockView, { scope, header: () => null, children: h("textarea") }) }));
	const pane = (kind: string) => view.find(`[data-dock-pane="${kind}"]`) as HTMLElement;
	try {
		await act(() => { usePaneDock.getState().open(scope, "terminal"); });
		const terminal = view.find("[data-test-terminal]");
		// 「+」里只列还没开的面板，点一下开成新标签；开过的不再列——能开好几个的（终端）除外。
		const offeredFrom = async (kind: string) => {
			await click(pane(kind).querySelector(`button[aria-label="${translate("pane.addTab")}"]`)!);
			return [...document.querySelectorAll('[role="menuitem"]')] as HTMLElement[];
		};
		const items = await offeredFrom("terminal");
		const offered = items.map((item) => item.textContent ?? "");
		assert.ok(offered.some((text) => text.includes(translate("common.terminal"))), "a terminal can always be opened again");
		const browserItem = items.find((item) => item.textContent?.includes(translate("browser.title")));
		assert.ok(browserItem, `the browser was not offered: ${offered.join(", ")}`);
		await click(browserItem);
		assert.equal(usePaneDock.getState().tab[scope], "browser");
		const again = (await offeredFrom("browser")).map((item) => item.textContent ?? "");
		assert.ok(!again.some((text) => text.includes(translate("browser.title"))), "an open panel was offered again");
		await click(pane("browser").querySelector(`button[aria-label="${translate("pane.addTab")}"]`)!);

		// 两个面板占同一格，在对话右边，只有新开的那个看得见。
		assert.equal(pane("terminal").style.left, pane("browser").style.left);
		assert.equal(pane("browser").style.width, "40.000000%");
		assert.equal(pane("browser").inert, false);
		assert.equal(pane("terminal").inert, true);

		// 点标签切过去，终端的 DOM 还是原来那一个。
		await click(pane("browser").querySelector('[data-panel-tab="terminal"] [role="tab"]')!);
		assert.equal(pane("terminal").inert, false);
		assert.equal(pane("browser").inert, true);
		assert.ok(view.find("[data-test-terminal]") === terminal, "switching tabs remounted the panel");

		// 工具栏按钮按到后台标签是切过去，按到当前标签才是关。
		await act(() => { toggleScopedPanel(scope, "browser"); });
		assert.equal(pane("browser").inert, false);
		await act(() => { toggleScopedPanel(scope, "browser"); });
		assert.equal(view.all('[data-dock-pane="browser"] [data-panel-tab="browser"]').length, 0);
		// 关掉当前标签，落到剩下的那个上。
		assert.equal(pane("terminal").inert, false);
	} finally {
		await view.unmount();
		unregister();
		usePaneDock.setState({ trees: {}, focused: {}, tab: {} });
	}
});

test("tabs layout, one screen: the column folds from its own card, comes back from the conversation's header, and folding closes nothing", async () => {
	Object.defineProperty(window, "plume", { configurable: true, value: { platform: "darwin" } });
	window.localStorage.clear();
	useApp.setState({ view: "chat", settings: { ...DEFAULT_SETTINGS} });
	usePaneDock.setState({ trees: {}, sizes: {}, maximized: {}, focused: {}, tab: {}, tabShare: 0.4, tabsCollapsed: false, host: null });
	const unregister = registerPanels([
		{ kind: "terminal", label: "common.terminal", icon: Terminal, shortcut: "", render: () => h("input", { "data-test-terminal": "" }) },
		{ kind: "browser", label: "browser.title", icon: Globe, shortcut: "", render: () => h("input", { "data-test-browser": "" }) },
	]);
	const scope = "lifted";
	// 对话卡片的标题栏：`after` 是 DockView 交给它的那颗展开按钮。
	const view = await mount(h(LayoutProvider, { children: h(DockView, { scope, header: (_insets, after) => h("div", { "data-test-header": "" }, after), foldable: true, children: h("textarea") }) }));
	const pane = (kind: string) => view.find(`[data-dock-pane="${kind}"]`) as HTMLElement;
	const header = () => view.find("[data-test-header]") as HTMLElement;
	const fold = () => pane(usePaneDock.getState().tab[scope]!).querySelector(`button[aria-label^="${translate("pane.hideColumn")}"]`) as HTMLElement;
	const unfold = () => header().querySelector(`button[aria-label^="${translate("pane.showColumn")}"]`) as HTMLElement;
	const toggle = () => (usePaneDock.getState().tabsCollapsed ? unfold() : fold());
	try {
		await act(() => { usePaneDock.getState().open(scope, "terminal"); });
		await act(() => { usePaneDock.getState().open(scope, "browser"); });
		const terminal = view.find("[data-test-terminal]");
		assert.equal(pane("browser").querySelectorAll("[data-panel-tab]").length, 2, "the column's card lost its tab strip");
		assert.ok(fold(), "the column's card has no fold button");
		assert.equal(unfold(), null, "the conversation offers to unfold a column that is open");

		// 收起：右栏不画了，展开按钮到了对话的标题栏；面板没关，终端还是那一个。
		await click(toggle());
		assert.equal(usePaneDock.getState().tabsCollapsed, true);
		assert.equal(pane("browser").inert, true);
		assert.equal(pane("terminal").inert, true);
		assert.ok(unfold(), "nothing in the conversation's header brings the column back");
		assert.deepEqual(panelsOf(usePaneDock.getState().tree(scope)), ["terminal", "browser"], "folding closed a panel");

		// 收着时按工具栏的「浏览器」，是展开去看它，不是把它关掉。
		await act(() => { toggleScopedPanel(scope, "browser"); });
		assert.equal(usePaneDock.getState().tabsCollapsed, false);
		assert.equal(pane("browser").inert, false);
		assert.ok(has(usePaneDock.getState().tree(scope), "browser"));

		// 再收起，用开关展开：回到原来那一格，终端没被重建。
		await click(toggle());
		await click(toggle());
		assert.equal(pane("browser").inert, false);
		assert.ok(view.find("[data-test-terminal]") === terminal, "folding remounted the panel");

		// 收着时开一个面板，也会展开。
		await click(toggle());
		await act(() => { usePaneDock.getState().open(scope, "terminal"); });
		assert.equal(usePaneDock.getState().tabsCollapsed, false);
		assert.equal(pane("terminal").inert, false);
	} finally {
		await view.unmount();
		unregister();
		usePaneDock.setState({ trees: {}, focused: {}, tab: {}, tabsCollapsed: false });
	}
});
