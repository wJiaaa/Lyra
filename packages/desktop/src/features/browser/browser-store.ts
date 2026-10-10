import { useEffect, useSyncExternalStore } from "react";
import { create } from "zustand";
import type { BrowserCommand, BrowserState, BrowserTab } from "../../../shared/browser.ts";
import { basePanelKind, panelInstance } from "../../lib/panel-instance.ts";
import { bridge } from "../../services/index.ts";
import { useApp } from "../../store/index.ts";
import { closePane, useSide, usePaneDock, usePanelWindows, type PanelKind } from "../dock/index.ts";

/** `loaded`：头一份状态到了没有。到之前什么网页都没有，不能据此认定哪个标签的网页没了。 */
export const useBrowser = create<BrowserState & { loaded: boolean }>(() => ({ tabs: [], activeId: null, loaded: false }));
export async function commandBrowser(command: BrowserCommand): Promise<void> {
	try { useBrowser.setState(await bridge.browser.command(command)); }
	catch (error) { useApp.getState().notify(String(error), "error"); }
}

/** Conversations and tabs are keyed together; a tab with no conversation gets the empty key. */
const browserOwner = (sessionId: string | null | undefined): string => sessionId ?? "";

const sessionOf = (scope: string): string | null => (scope === "@draft" ? null : scope);

/** 一个网页在右栏里的那一格。 */
const browserPanel = (id: string): PanelKind => `browser:${id}`;

/** 在这一屏的会话里开一个空白网页。标签随后由 `reveal` 开出来，见 `useBrowserWorkspace`。 */
export function newBrowserPage(scope: string): void {
	void commandBrowser({ type: "open", url: "about:blank", sessionId: sessionOf(scope), newTab: true });
}

/**
 * 关掉一个网页标签：这一页就没了，和浏览器里关一个标签页一样。
 *
 * 同一会话的别的网页不受影响，agent 在后台开着的也一样——它们还没变成标签，人也没说要关。
 */
export function closeBrowser(_scope: string, kind: string): void {
	const id = panelInstance(kind);
	if (id) void commandBrowser({ type: "close", id });
}

/**
 * How many conversations keep their pages loaded at once.
 *
 * Every visible tab is a `<webview>`, and every `<webview>` is a renderer process of its own —
 * with tabs scoped per conversation, keeping them all mounted would mean the browser's cost grew
 * with the number of conversations you had ever opened a page in, for pages nobody was looking at.
 *
 * Three, not one: switching to a conversation and straight back is the common move, and dropping
 * the page on the way out reloads it on the way back — losing scroll position, and anything typed
 * into a form. Three covers that without letting the count run away. A conversation whose agent is
 * mid-turn is kept regardless of this — see `browserMounted`.
 */
const LOADED_SESSIONS = 3;

/** The conversations whose pages stay loaded, most recently looked at first. */
export const useBrowserView = create<{ recent: string[] }>(() => ({ recent: [] }));

export function browserVisited(sessionId: string | null): void {
	const owner = browserOwner(sessionId);
	useBrowserView.setState((state) => state.recent[0] === owner
		? state
		: { recent: [owner, ...state.recent.filter((entry) => entry !== owner)].slice(0, LOADED_SESSIONS) });
}

/**
 * The tabs that get a page, as opposed to the tabs that get a row.
 *
 * Wider than what is on screen, and deliberately: an agent working in a conversation you are not
 * watching drives a real page, so its tabs stay loaded while its turn is in flight, and `wanted`
 * covers the moment between the main process asking for a page and the store hearing that the turn
 * has started.
 */
function browserMounted(tabs: BrowserTab[], owner: string, recent: string[], running: Record<string, unknown>): BrowserTab[] {
	return tabs.filter((tab) => {
		const key = browserOwner(tab.sessionId);
		return key === owner || tab.wanted === true || recent.includes(key) || (tab.sessionId !== null && tab.sessionId in running);
	});
}

export function useBrowserWorkspace(): void {
	useEffect(() => {
		const unsubscribe = bridge.browser.onChanged((state) => {
			useBrowser.setState({ tabs: state.tabs, activeId: state.activeId, loaded: true });
			/*
			 * A page becomes a tab only when a person asked, and only in a screen showing its conversation.
			 *
			 * `reveal` is set by the main process for a new page, a bookmark, a preview link or a card's
			 * 「打开」 — never for an agent's own pages, which run with no tab of their own (see
			 * `openBrowser`) until someone opens them from the card. It used to mean any page opening,
			 * which dropped the panel over your work each time an agent opened or clicked something.
			 *
			 * Into the screen of the conversation that owns the page, and nowhere if none shows it: a
			 * screen showing another conversation would get a tab of a page that is not its own. That is
			 * why this asks `size` rather than going through `openScopedPanel`, which falls back to the
			 * focused screen.
			 */
			const revealed = state.tabs.find((tab) => tab.id === state.activeId);
			const screen = revealed ? (revealed.sessionId ?? "@draft") : null;
			if (state.reveal && revealed && screen && usePaneDock.getState().size(screen)) usePaneDock.getState().open(screen, browserPanel(revealed.id));
		});
		void bridge.browser.state().then((state) => useBrowser.setState({ ...state, loaded: true }));
		const unwatch = useSide.subscribe((state, previous) => {
			if (state.browserTarget === previous.browserTarget || !state.browserTarget) return;
			const target = state.browserTarget;
			const url = target.kind === "url" ? target.url : `ly-preview://${target.preview.sessionId}/${target.preview.id}/${target.preview.entry}${target.preview.fragment ?? ""}`;
			// The conversation that asked, when it said: a preview pressed in a screen without focus is that screen's page.
			const owner = target.kind === "preview" && target.sessionId !== undefined ? target.sessionId : useApp.getState().activeSessionId;
			void commandBrowser({ type: "open", url, sessionId: owner, newTab: true });
		});
		return () => { unsubscribe(); unwatch(); };
	}, []);
}

/**
 * Which pages a screen gives a `<webview>` to.
 *
 * A page lives in exactly one place, because a `<webview>` moved or re-created is a page reloaded —
 * its scroll, its form, whatever the agent had done in it. So each page has one host:
 *
 * - A detached browser window hosts its own conversation's pages.
 * - A screen hosts its own conversation's pages, whether they are tabs there or not. Each page's
 *   pane is mounted from the moment the page exists, hidden while it has no tab, so opening it from
 *   its card shows the page that was already running rather than loading it again.
 * - Pages of conversations that are on no screen but still have to stay loaded — the few looked at
 *   most recently, anything an agent is driving — are hosted by the screen that has been on screen
 *   longest (`host`).
 *
 * Nothing here depends on the focus. There used to be a window-level browser as well, and pages
 * were handed between it and a screen's according to which screen had the focus — a reload on
 * every click between two screens. After that, a screen closing its panel handed its pages to the
 * host and took them back on reopening — a reload each way, and the form typed into was gone.
 *
 * A screen counts from the moment it has been measured (`sizes`), on both sides of the rule at
 * once: before that its pages stay with the host, so no page is ever drawn in two places.
 */
function browserPages(scope: string): BrowserTab[] {
	const { tabs } = useBrowser.getState();
	const { recent } = useBrowserView.getState();
	const { turns } = useApp.getState();
	const { sizes, host } = usePaneDock.getState();
	const { panels, opening } = usePanelWindows.getState();
	const sessionId = sessionOf(scope);
	const owner = browserOwner(sessionId);
	const own = tabs.filter((tab) => browserOwner(tab.sessionId) === owner);
	if (bridge.bootWindow?.kind === "panel") return own;
	const external = [...panels, ...opening].filter((panel) => basePanelKind(panel.kind) === "browser");
	const outside = (tab: BrowserTab) => external.some((panel) =>
		browserOwner(panel.sessionId === undefined ? panel.scope === "@draft" ? null : panel.scope : panel.sessionId) === browserOwner(tab.sessionId));
	const onScreen = (key: string) => Boolean(sizes[key]);
	if (!scope) return [];
	if (scope !== host) return onScreen(scope) ? own.filter((tab) => !outside(tab)) : [];
	return browserMounted(tabs, owner, recent, turns).filter((tab) => {
		if (outside(tab)) return false;
		const key = tab.sessionId ?? "@draft";
		return key === scope || !onScreen(key);
	});
}

/**
 * 每一屏要一直挂着的网页格子：它托管的每一页一格，不论这一页是不是它的标签。见 `PanelDefinition.residents`。
 *
 * 读的是几个 store 的现状，哪个变了都可能换一页的去处，所以都订着。是函数声明而不是一个对象常量：
 * 注册表在模块环里先于这个文件求值，常量那时还没初始化。
 */
export function subscribeBrowserResidents(listener: () => void): () => void {
	const stops = [useBrowser, useBrowserView, useApp, usePaneDock, usePanelWindows].map((store) => store.subscribe(listener));
	return () => {
		for (const stop of stops) stop();
	};
}
export function browserResidentsOf(scope: string): PanelKind[] {
	return browserPages(scope).map((tab) => browserPanel(tab.id));
}

/** 这一屏托管着这一页没有——托管着才给它一个 `<webview>`，同一页在两处各挂一个就是两个页面。 */
export function useBrowserHosted(scope: string | null, id: string | null): boolean {
	return useSyncExternalStore(subscribeBrowserResidents, () => Boolean(scope && id) && browserPages(scope!).some((tab) => tab.id === id));
}

/** 人关掉这一格网页标签，和点它的 ✕ 一样：标签滑走，网页跟着关掉。 */
export function closeBrowserTab(scope: string, kind: string): void {
	closePane(scope, kind as PanelKind);
}

/** 网页已经没了，它的标签跟着退下，不再去关那一页。 */
export function dropBrowserTab(scope: string, kind: string): void {
	usePaneDock.getState().close(scope, kind as PanelKind);
}
