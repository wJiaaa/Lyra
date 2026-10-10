/**
 * 浏览器按会话分家：右栏里一个网页一个标签，活着的页面比标签多一点。
 *
 * 「多一点」是全部难点。网页一直是有主的——agent 的工具就是靠这个判定谁能操作谁——而每个
 * `<webview>` 是一个渲染进程，要是每个会话的页面都留着，开销就随「你曾经在几个会话里开过网页」一直涨。
 * agent 在后台开的页面还没变成标签，也得有个地方活着。
 *
 * 所以这里量这几件事：一页只在一处挂着；来回切一次页面还在不在（在，否则表单和滚动位置每切一次丢一次）；
 * 切得够远之后旧的有没有真的被卸掉；后台页面变成标签时是不是原地亮出来，而不是重载。外加一条不能退让的：
 * 另一个会话的 agent 正在跑，它的页面必须活着，哪怕你根本没在看它——那正是它替你干活的时候。
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { act, createElement as h } from "react";
import type { BrowserState, BrowserTab } from "../../shared/browser.ts";
import { useBrowser, useBrowserView, useBrowserWorkspace } from "../../src/features/browser/browser-store.ts";
import { BrowserTabTitle } from "../../src/features/browser/BrowserPanel.tsx";
import { translate } from "../../src/i18n/translate.ts";
import { useApp } from "../../src/store/index.ts";
import { mount, type Mounted } from "../helpers/mount.ts";
import { SessionScope } from "../../src/app/session-scope.tsx";
import { LayoutProvider } from "../../src/app/layout.tsx";
import { DockView } from "../../src/features/dock/DockView.tsx";
import { usePaneDock } from "../../src/features/dock/pane-store.ts";
import { usePanelWindows } from "../../src/features/dock/popout.ts";
import { insertTab } from "../../src/features/dock/tabs.ts";
import { has, leafOf, type DockNode } from "../../src/features/dock/tree.ts";

function stub(extra: object = {}) {
	Object.defineProperty(window, "plume", { configurable: true, value: {
		platform: "darwin",
		bootWindow: { id: "test", kind: "primary", sessionId: null, panelKind: null, panelScope: null },
		...extra,
	} });
}
beforeEach(() => { window.localStorage.clear(); stub(); });
afterEach(() => {
	Reflect.deleteProperty(window, "plume");
	usePaneDock.setState({ trees: {}, sizes: {}, maximized: {}, focused: {}, tab: {}, host: null });
	usePanelWindows.setState({ opening: [], panels: [] });
});

function tab(id: string, sessionId: string | null, extra: Partial<BrowserTab> = {}): BrowserTab {
	return { id, sessionId, url: `https://${id}.example.com/`, title: id, loading: false, canGoBack: false, canGoForward: false, zoom: 1, viewport: null, ...extra };
}

const TABS = [tab("a1", "a"), tab("a2", "a"), tab("b1", "b"), tab("c1", "c"), tab("d1", "d")];
const SIZE = { width: 600, height: 800 };

/** A conversation's screen with these pages open as tabs. */
const withPages = (...ids: string[]): DockNode => ids.reduce((tree, id) => insertTab(tree, `browser:${id}`), leafOf("conversation") as DockNode);

/** One conversation's screen: `DockView` itself, inside its conversation the way the app puts it. */
function screen(scope: string) {
	return h("section", { id: `screen-${scope}` }, h(SessionScope.Provider, { value: scope }, h(DockView, { scope, header: () => null, children: h("textarea") })));
}
const screens = (...scopes: string[]) => mount(h(LayoutProvider, { children: h("div", null, ...scopes.map(screen)) }));
const pagesIn = (view: Mounted, scope: string) => view.all(`#screen-${scope} webview`).map((el) => el.dataset.browserPage).sort();
const paneOf = (page: Element) => page.closest("[data-dock-pane]") as HTMLElement;

test("the screen that keeps background pages yields a conversation's pages to the screen showing them, and to its own window", async () => {
	useBrowser.setState({ tabs: TABS, activeId: "a1", loaded: true });
	useBrowserView.setState({ recent: ["a", "b"] });
	useApp.setState({ activeSessionId: "a", turns: { d: { startedAt: 1, tokens: 0 } }, settings: null });
	// Two screens, both with a page open; `a` has been on screen longest, so it keeps the rest.
	usePaneDock.setState({ trees: { a: withPages("a1"), b: withPages("b1") }, sizes: { a: SIZE, b: SIZE }, host: "a" });
	const view = await screens("a", "b");
	try {
		assert.deepEqual(pagesIn(view, "a"), ["a1", "a2", "d1"], "its own, and the agent working off screen");
		assert.deepEqual(pagesIn(view, "b"), ["b1"], "b's page lives in b's screen, once");
		assert.equal(view.all("webview").length, 4, "one page per tab, never two");
		await act(() => { usePanelWindows.setState({ opening: [{ kind: "browser", scope: "a", sessionId: "a" }] }); });
		assert.equal(view.all('[data-browser-page="a1"]').length, 0, "a window of its own takes a's pages");
		await act(() => { usePanelWindows.setState({ opening: [] }); });
		assert.equal(view.all('[data-browser-page="a1"]').length, 1);
	} finally { await view.unmount(); }
});

test("moving the focus between two screens moves no page", async () => {
	/*
	 * Pages used to be handed between a window-level browser and a screen's according to which
	 * screen had the focus: a reload on every click between two screens. A page belongs to the screen
	 * showing it, and the focus has nothing to say about that.
	 */
	useBrowser.setState({ tabs: TABS, activeId: "a1", loaded: true });
	useBrowserView.setState({ recent: ["a", "b"] });
	useApp.setState({ activeSessionId: "a", turns: {}, settings: null });
	usePaneDock.setState({ trees: { a: withPages("a1"), b: withPages("b1") }, sizes: { a: SIZE, b: SIZE }, host: "a" });
	const view = await screens("a", "b");
	try {
		const a = view.find('[data-browser-page="a1"]');
		const b = view.find('[data-browser-page="b1"]');
		await act(() => { useApp.setState({ activeSessionId: "b" }); useBrowser.setState({ activeId: "b1" }); });
		// `assert.ok` on identity, never `assert.equal` on DOM nodes: a failing one hangs the whole file.
		assert.ok(view.find('[data-browser-page="a1"]') === a, "a's page is the same element — not reloaded");
		assert.ok(view.find('[data-browser-page="b1"]') === b);
		await act(() => { useApp.setState({ activeSessionId: "a" }); useBrowser.setState({ activeId: "a1" }); });
		assert.ok(view.find('[data-browser-page="b1"]') === b, "and back again");
	} finally { await view.unmount(); }
});

test("pages with no tab still run, in their own screen; the host keeps the ones on no screen", async () => {
	useBrowser.setState({ tabs: TABS, activeId: "a1", loaded: true });
	useBrowserView.setState({ recent: ["a", "b", "c"] });
	useApp.setState({ activeSessionId: "a", turns: {}, settings: null });
	usePaneDock.setState({ trees: {}, sizes: { a: SIZE, b: SIZE }, host: "a" });
	const view = await screens("a", "b");
	try {
		assert.deepEqual(pagesIn(view, "b"), ["b1"], "an agent's pages run without a tab, in their own screen");
		assert.deepEqual(pagesIn(view, "a"), ["a1", "a2", "c1"], "its own, and a recent conversation that is on no screen");
		assert.ok(view.all("webview").every((page) => paneOf(page).hasAttribute("inert")), "and none of them is shown");
	} finally { await view.unmount(); }
});

test("a background page becomes a tab where it already is: no reload, on any screen", async () => {
	/*
	 * An agent's page runs with no tab until someone presses 「打开」 on its card. The tab that comes
	 * up is the pane the page was already in; a new `<webview>` would be the page loaded again, and
	 * whatever the agent had done in it gone.
	 */
	useBrowser.setState({ tabs: TABS, activeId: "b1", loaded: true });
	useBrowserView.setState({ recent: ["a", "b"] });
	useApp.setState({ activeSessionId: "b", turns: {}, settings: null });
	usePaneDock.setState({ trees: { a: withPages("a1") }, sizes: { a: SIZE, b: SIZE }, host: "a" });
	const view = await screens("a", "b");
	try {
		const b = view.find('#screen-b [data-browser-page="b1"]');
		assert.ok(paneOf(b).hasAttribute("inert"), "no tab yet: hidden");
		await act(() => { usePaneDock.getState().open("b", "browser:b1"); });
		assert.ok(view.find('[data-browser-page="b1"]') === b, "the same page");
		assert.equal(paneOf(b).hasAttribute("inert"), false, "now on screen");
		assert.equal(view.all('[data-browser-page="b1"]').length, 1);
	} finally { await view.unmount(); }
});

test("a screen not measured yet leaves its pages with the host, so no page is ever drawn twice", async () => {
	useBrowser.setState({ tabs: TABS, activeId: "a1", loaded: true });
	useBrowserView.setState({ recent: ["a", "b"] });
	useApp.setState({ activeSessionId: "a", turns: {}, settings: null });
	usePaneDock.setState({ trees: {}, sizes: { a: SIZE }, host: "a" });
	const view = await screens("a", "b");
	try {
		assert.deepEqual(view.all('[data-browser-page="b1"]').map((el) => el.closest("section")?.id), ["screen-a"]);
		await act(() => { usePaneDock.setState({ sizes: { a: SIZE, b: SIZE } }); });
		assert.deepEqual(view.all('[data-browser-page="b1"]').map((el) => el.closest("section")?.id), ["screen-b"], "measured: it moves to its own screen, once");
	} finally { await view.unmount(); }
});

/** One screen, the only one, following the conversation the user is in. */
async function following(sessionId: string, turns: Record<string, { startedAt: number; tokens: number }> = {}, tree?: DockNode) {
	useBrowser.setState({ tabs: TABS, activeId: "a1", loaded: true });
	useBrowserView.setState({ recent: [] });
	useApp.setState({ activeSessionId: sessionId, turns, settings: null });
	// The one screen there is, which is therefore the one that keeps pages.
	usePaneDock.setState({ trees: tree ? { [sessionId]: tree } : {}, sizes: {}, host: sessionId });
	function Following() {
		return screen(useApp((state) => state.activeSessionId) ?? "@draft");
	}
	const view = await mount(h(LayoutProvider, { children: h(Following) }));
	return {
		view,
		// Through `act`: switching conversations is a state update React has to finish committing
		// before the next line looks at the DOM.
		async switchTo(next: string) {
			await act(async () => { useApp.setState({ activeSessionId: next }); usePaneDock.setState({ host: next }); });
		},
		/** The pages with a `<webview>` — one renderer process each. */
		loaded: () => view.all("[data-browser-page]").map((page) => page.dataset.browserPage).sort(),
	};
}

test("each page is a tab of its own, named after the page, and only the current one shows", async () => {
	const app = await following("a", {}, withPages("a1", "a2"));
	try {
		const shown = app.view.all("[data-dock-pane]:not([inert])").find((pane) => pane.dataset.dockPane?.startsWith("browser:"))!;
		const titles = [...shown.querySelectorAll('[data-panel-tab^="browser:"]')].map((entry) => entry.textContent);
		assert.deepEqual(titles, ["a1", "a2"]);
		const visible = app.view.all("[data-browser-page]").filter((page) => !paneOf(page).hasAttribute("inert"));
		assert.equal(visible.length, 1);
		/*
		 * Asked as "not hidden" rather than "declared visible": the page declares nothing — see the
		 * note in `BrowserPage`. `visibility` is inherited, and a descendant that asserts `visible`
		 * climbs back out of an ancestor that is `hidden`: settings put the whole workspace away with
		 * `invisible`, and a webview that insisted on being visible painted over it.
		 */
		assert.equal((visible[0].parentElement as HTMLElement).style.visibility, "", "页面不能写死 visible，否则设置页盖不住它");
		await app.switchTo("b");
		assert.equal(app.view.all('[data-panel-tab^="browser:"]').length, 0, "b has opened no page as a tab");
	} finally { await app.view.unmount(); }
});

test("a tab whose page is gone takes itself off, once the pages are known", async () => {
	const app = await following("a", {}, withPages("a1", "gone"));
	try {
		const tree = () => usePaneDock.getState().tree("a");
		assert.ok(has(tree(), "browser:a1"));
		assert.equal(has(tree(), "browser:gone"), false, "closed by the agent, or left over from before a restart");
		await act(() => { useBrowser.setState({ loaded: false }); usePaneDock.getState().open("a", "browser:later"); });
		assert.ok(has(tree(), "browser:later"), "before the first state arrives nothing is known to be gone");
	} finally { await app.view.unmount(); }
});

test("switching away and back keeps the page; switching far enough drops it", async () => {
	const app = await following("a");
	try {
		assert.deepEqual(app.loaded(), ["a1", "a2"]);
		await app.switchTo("b");
		// Still loaded one conversation later: going back must not reload and lose what was typed.
		assert.deepEqual(app.loaded(), ["a1", "a2", "b1"]);
		await app.switchTo("c");
		await app.switchTo("d");
		// Four conversations deep, the first one's pages are gone rather than piling up.
		assert.deepEqual(app.loaded(), ["b1", "c1", "d1"]);
	} finally { await app.view.unmount(); }
});

test("a conversation with a turn in flight keeps its page wherever the user is", async () => {
	const app = await following("a", { d: { startedAt: Date.now(), tokens: 0 } });
	try {
		// `d` is off screen and three conversations away, but its agent is working in it.
		assert.ok(app.loaded().includes("d1"));
		await app.switchTo("b");
		await app.switchTo("c");
		assert.ok(app.loaded().includes("d1"), "an agent's own page cannot be dropped under it");
	} finally { await app.view.unmount(); }
});

test("the main process can ask for a sleeping page back", async () => {
	const app = await following("a");
	try {
		await app.switchTo("b");
		await app.switchTo("c");
		await app.switchTo("d");
		assert.equal(app.loaded().includes("a1"), false);
		// What `awakeBrowser` publishes when an agent reaches for a tab whose page was dropped.
		await act(async () => { useBrowser.setState({ tabs: TABS.map((entry) => entry.id === "a1" ? { ...entry, wanted: true } : entry), activeId: "a1" }); });
		assert.ok(app.loaded().includes("a1"));
	} finally { await app.view.unmount(); }
});

test("a page a person opened becomes a tab in the screen of its conversation, and nowhere else", async () => {
	let changed = (_state: BrowserState & { reveal?: boolean }) => {};
	stub({ browser: { onChanged: (listener: typeof changed) => { changed = listener; return () => {}; }, state: async () => ({ tabs: [], activeId: null }) } });
	usePaneDock.setState({ trees: {}, sizes: { a: SIZE }, host: "a" });
	function Workspace() { useBrowserWorkspace(); return null; }
	const view = await mount(h(Workspace));
	try {
		const opened = [tab("n1", "a")];
		changed({ tabs: opened, activeId: "n1", reveal: true });
		assert.ok(has(usePaneDock.getState().tree("a"), "browser:n1"));
		// An agent's page: no tab until someone opens it from the card.
		changed({ tabs: [...opened, tab("n2", "a")], activeId: "n2", reveal: false });
		assert.equal(has(usePaneDock.getState().tree("a"), "browser:n2"), false);
		// A conversation on no screen: not into whichever screen happens to have the focus.
		changed({ tabs: [...opened, tab("o1", "o")], activeId: "o1", reveal: true });
		assert.equal(has(usePaneDock.getState().tree("a"), "browser:o1"), false);
		assert.equal(has(usePaneDock.getState().tree("o"), "browser:o1"), false);
	} finally { await view.unmount(); }
});

test("a blank page's tab says 新标签页, not the address Chromium reports as its title", async () => {
	useBrowser.setState({ tabs: [tab("blank", "a", { url: "about:blank", title: "about:blank" }), tab("named", "a")], loaded: true });
	const view = await mount(h("div", null,
		h("span", { id: "blank" }, h(BrowserTabTitle, { scope: "a", kind: "browser:blank", fallback: "?" })),
		h("span", { id: "named" }, h(BrowserTabTitle, { scope: "a", kind: "browser:named", fallback: "?" }))));
	try {
		assert.equal(view.find("#blank").textContent, translate("browser.newTab"));
		assert.equal(view.find("#named").textContent, "named");
	} finally { await view.unmount(); }
});
