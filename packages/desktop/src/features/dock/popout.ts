/**
 * Which screen a panel opens in, and a panel leaving for a real window and coming back.
 *
 * **A panel belongs to a conversation.** There is no window-level place for it: a single screen is
 * a split of one, and every request — a toolbar button, a shortcut, a file link in the transcript,
 * a page the address bar opened — lands in the dock of the screen it was made from. See
 * `docs/adr/0023-containers-belong-to-sessions.md` for the layer this replaced and what it cost.
 *
 * **Popping out only ever happens because a person pressed the button.** Which panels may go at all
 * is the panel's own answer — `detach` on its definition. A second renderer does not inherit a
 * `<webview>`, a store or a subscription; `docs/architecture/split-window-conflicts.md` §7 has the
 * table.
 *
 * **Coming back goes to the conversation it left from.** If that conversation is on screen the panel
 * returns to its old tab position; if not, pressing 「收回」 brings the conversation back on screen first,
 * because docking a panel somewhere nobody can see looks exactly like losing it.
 */

import { create } from "zustand";
import { provideFileOpener } from "../../app/file-opener.ts";
import { provideSideQuote } from "../../app/side-quote.ts";
import { flushSync } from "react-dom";
import { bridge } from "../../services/index.ts";
import { translate } from "../../i18n/translate.ts";
import { useApp } from "../../store/index.ts";
import { applyFilePanelState, filePanelSnapshot } from "../../store/file-panel-handoff.ts";
import { fileSlot, openFileOf, useOpenFile } from "../../store/openFile.ts";
import { allowsMany, basePanelKind, nextPanelKind, sideIdOfPanel } from "../../lib/panel-instance.ts";
import { baseName } from "../../lib/paths.ts";
import { emptyDockTree, usePaneDock } from "./pane-store.ts";
import { has, kinds, remove, type DockNode, type PaneKind } from "./tree.ts";
import { paneStorageKey, readTree, sanitize, writeTree } from "./persist.ts";
import { allPanels, detachOf, panelOf } from "./panels/registry.ts";
import { activeTab, insertTab, panelsOf } from "./tabs.ts";
import { useSide, type PanelKind } from "./sideStore.ts";

interface PanelWindowRef {
	kind: string;
	scope: string;
	sessionId?: string | null;
}

interface Home {
	scope: string;
	/** 走之前是第几个标签。旧版本写下的记录没有它，收回时排在最后。 */
	index?: number | null;
	before?: unknown;
	rest?: unknown;
}

/**
 * 面板弹出去之前是从哪儿走的——这份记录要活过刷新。
 *
 * 面板窗口的寿命独立于主窗口的刷新，所以这份记录的寿命也该如此：存 localStorage，和布局同一个
 * 去处。它很小（kind → scope/index），坏数据当作「没有记录」。
 */
const HOMES_KEY = "dw:homes";

function readHomes(): Record<string, Home> {
	try {
		const raw = window.localStorage.getItem(HOMES_KEY);
		if (!raw) return {};
		const parsed = JSON.parse(raw) as unknown;
		return parsed && typeof parsed === "object" ? (parsed as Record<string, Home>) : {};
	} catch {
		// 坏数据、存储关了、没有 window——都当作「没有记录」，收回时落默认位置而已。
		return {};
	}
}

function writeHomes(next: Record<string, Home>): void {
	try {
		window.localStorage.setItem(HOMES_KEY, JSON.stringify(next));
	} catch {
		// 存不下不该让弹出这件事失败。
	}
}

const homes = {
	get(key: string): Home | undefined {
		return readHomes()[key];
	},
	set(key: string, home: Home): void {
		writeHomes({ ...readHomes(), [key]: home });
	},
	delete(key: string): void {
		const all = readHomes();
		if (!(key in all)) return;
		delete all[key];
		writeHomes(all);
	},
};

const homeKey = (scope: string, kind: string): string => `${scope}:${kind}`;

export const usePanelWindows = create<{ panels: PanelWindowRef[]; opening: PanelWindowRef[] }>(() => ({ panels: [], opening: [] }));

function isPopped(scope: string, kind: string): boolean {
	const { panels, opening } = usePanelWindows.getState();
	return [...panels, ...opening].some((panel) => panel.scope === scope && panel.kind === kind);
}

function sessionOf(scope: string): string | null {
	return !scope || scope === "@draft" ? null : scope;
}

/**
 * Is this renderer a detached panel, rather than a window with a workspace in it?
 *
 * Guarded because `bridge` throws when the preload has not run, and the answer for every caller
 * here is then "no" rather than an exception: a unit test drives these functions directly.
 */
function inPanelWindow(): boolean {
	try {
		return bridge.bootWindow?.kind === "panel";
	} catch {
		return false;
	}
}

/*
 * 「人此刻在哪一屏」和「把某个会话请上屏」——两个答案都由分屏那一层注入进来。
 *
 * 这里不直接去问 `useSplit`：dock 反过来依赖分屏会连出一个环（dock → split → dock），把这段挪进
 * 分屏那一域也一样。注入是两边都不破的解法。没有工作区的窗口（会话窗口、面板窗口）根本不加载
 * `SplitWorkspace`，于是默认答案 null 正好是它们的正确答案：那里没有可以开面板的地方。
 */
let readScope: () => string | null = () => null;
let revealScope: (scope: string) => void = () => {};

export function provideScope(fn: () => string | null): void {
	readScope = fn;
}

export function provideReveal(fn: (scope: string) => void): void {
	revealScope = fn;
}

/** The screen a request with no other answer belongs to: the one the person is working in. */
export function currentScope(): string | null {
	return readScope();
}

export async function popOutPanel(input: { scope: string; kind: PanelKind; sessionId: string | null }): Promise<boolean> {
	if (!bridge.windows?.openPanel) return false;
	// A panel that cannot survive a second renderer does not get moved into one. The header hides
	// the button for these, so this is the second line rather than the first.
	if (detachOf(input.kind) === "none") return false;
	if (isPopped(input.scope, input.kind)) return true;
	const tree = usePaneDock.getState().tree(input.scope);
	const previousHome = !has(tree, input.kind) ? homes.get(homeKey(input.scope, input.kind)) : undefined;
	const home: Home = previousHome ?? {
		scope: input.scope,
		index: has(tree, input.kind) ? panelsOf(tree).indexOf(input.kind) : null,
		before: tree,
		rest: remove(tree, input.kind),
	};
	homes.set(homeKey(input.scope, input.kind), home);
	// Commit the ownership transfer before another document can attach the same browser tab.
	flushSync(() => {
		usePanelWindows.setState((state) => ({ opening: [...state.opening, input] }));
		usePaneDock.getState().close(input.scope, input.kind);
	});
	let opened = false;
	try {
		opened = (await bridge.windows.openPanel({ kind: input.kind, scope: input.scope, sessionId: input.sessionId, ...(basePanelKind(input.kind) === "file" ? { fileState: filePanelSnapshot(fileSlot(input.scope, input.kind)) } : {}) })).ok;
	} finally {
		if (!opened) {
			usePanelWindows.setState((state) => ({ opening: state.opening.filter((panel) => panel.scope !== input.scope || panel.kind !== input.kind) }));
			// Rollback is a transaction, not a new placement request: a failed window must not lose its pane.
			const current = usePaneDock.getState().tree(input.scope);
			if (has(tree, input.kind) && !has(current, input.kind)) {
				const restored = JSON.stringify(home.rest) === JSON.stringify(current) ? tree : insertTab(current, input.kind, home.index ?? undefined);
				usePaneDock.getState().restoreLayout(input.scope, restored);
			}
			if (previousHome) homes.set(homeKey(input.scope, input.kind), previousHome);
			else homes.delete(homeKey(input.scope, input.kind));
		}
	}
	return opened;
}

/** Restore the exact tab order only while the remaining dock still matches the departure snapshot. */
export function restoredHomeTree(home: { before?: unknown; rest?: unknown } | undefined, tree: DockNode, kind: PaneKind): DockNode | null {
	if (!home?.before || JSON.stringify(home.rest) !== JSON.stringify(tree)) return null;
	const restored = sanitize(home.before, [...kinds(tree), kind]);
	return has(restored, kind) ? restored : null;
}

/** Put the panel back into a screen that is on screen and has measured itself. */
function dockIntoLive(kind: PanelKind, scope: string, home: Home | undefined): boolean {
	const dock = usePaneDock.getState();
	if (!dock.size(scope)) return false;
	const tree = dock.tree(scope);
	if (has(tree, kind)) return true;
	const snapshot = restoredHomeTree(home, tree, kind);
	if (snapshot) {
		dock.restoreLayout(scope, snapshot);
		return true;
	}
	return dock.open(scope, kind, home?.index ?? undefined);
}

/**
 * Put the panel back into a conversation that is not on screen: into its stored layout, where it
 * will be the next time that conversation is shown.
 */
function dockIntoStored(kind: PanelKind, scope: string, home: Home | undefined): void {
	const dock = usePaneDock.getState();
	const inMemory = dock.trees[scope];
	const allowed: PaneKind[] = ["conversation", ...allPanels().filter((panel) => !panel.ephemeral).map((panel) => panel.kind)];
	const tree = inMemory ?? readTree(paneStorageKey(scope), allowed) ?? emptyDockTree;
	if (has(tree, kind)) return;
	const snapshot = restoredHomeTree(home, tree, kind);
	const next = snapshot ?? insertTab(tree, kind, home?.index ?? undefined);
	if (inMemory) dock.restoreLayout(scope, next);
	else writeTree(paneStorageKey(scope), next);
}

/**
 * Bring a detached panel home.
 *
 * `reveal` is whether the person asked for it (the 「收回」 button) rather than the app tidying up
 * after a crash. A person asking wants to see it arrive, so a conversation that is off screen is
 * brought on screen first; tidying up must never rearrange the workspace behind anyone's back, so
 * it writes the panel into that conversation's stored layout instead.
 */
async function dockBack(kind: PanelKind, scope: string, reveal: boolean): Promise<boolean> {
	const home = homes.get(homeKey(scope, kind));
	if (dockIntoLive(kind, scope, home)) {
		homes.delete(homeKey(scope, kind));
		return true;
	}
	if (reveal && scope !== "@draft") {
		revealScope(scope);
		// The screen needs a frame or two to mount and measure itself before it can take the panel.
		for (let waited = 0; waited < 3_000; waited += 50) {
			await new Promise((resolve) => setTimeout(resolve, 50));
			if (dockIntoLive(kind, scope, home)) {
				homes.delete(homeKey(scope, kind));
				return true;
			}
		}
	}
	dockIntoStored(kind, scope, home);
	homes.delete(homeKey(scope, kind));
	return true;
}

/**
 * 从会话内容里打开一个面板——点一个文件链接、点「审核」、点子智能体、「在终端运行」、地址栏打开的网页。
 *
 * 和工具条上那排按钮走同一套规矩：开在人此刻所在的那一屏，那一屏就是这个请求所属的会话。
 *
 * Answers with the screen the panel went to, so a caller that hands the panel something to do —
 * a command for the terminal — can address the same screen, including when `target` was not on
 * screen and the request fell back to the focused one. Null when no screen in this window took it.
 */
export function openScopedPanel(kind: PanelKind, target?: string): string | null {
	/*
	 * A panel window has no dock, so the request goes to the window that does.
	 *
	 * In this renderer nothing is subscribed to a dock — it draws one panel and nothing else. So
	 * clicking a file in a detached file tree would update a store nobody reads. See
	 * `docs/architecture/split-window-conflicts.md` §7.
	 */
	if (inPanelWindow()) {
		if (bridge.windows?.openPanelInMain) void bridge.windows.openPanelInMain(inMain(kind, target));
		return null;
	}
	/*
	 * `target` names the screen the request belongs to. Without it the request goes to the screen
	 * with focus: right for a press, which focuses its screen first, and wrong for the keyboard, which
	 * reaches a control in another screen without that press. So a control drawn inside a screen
	 * passes its own (`useDockScope`), and so does a request that is not a click at all — an
	 * announcement, a page an agent revealed.
	 */
	const scope = screenFor(target);
	if (!scope) return null;
	if (isPopped(scope, kind)) {
		if (bridge.windows?.openPanel) void bridge.windows.openPanel({ kind, scope, sessionId: sessionOf(scope), ...(basePanelKind(kind) === "file" ? { fileState: filePanelSnapshot(fileSlot(scope, kind)) } : {}) });
		return scope;
	}
	usePaneDock.getState().open(scope, kind);
	return scope;
}

/** The screen a request made from `target` lands in: that one while it is on screen, else the one with focus. */
function screenFor(target: string | undefined): string | null {
	return target && usePaneDock.getState().size(target) ? target : readScope();
}

/**
 * What a panel window asks the main window for, with the thing the main window cannot know.
 *
 * The screen: the one this panel was popped out of, which is where the request was made — the main
 * window's focus is on some other screen as often as not. The file, for a file pane, is named by
 * `openFilePane`: this window's open-file store is its own.
 */
function inMain(kind: PanelKind, target: string | undefined) {
	const scope = target ?? bridge.bootWindow?.panelScope ?? undefined;
	return { kind, ...(scope ? { scope } : {}) };
}

/**
 * 把一个文件打开到一屏的文件标签里。
 *
 * 每个文件是顶上那排标签里的一个，各看各的文件（`store/openFile.ts`）。已经有一格开着它就切过去；
 * 有一格空着——从菜单或「+」开出来还没选文件的——就用那一格；最早那一格 `file` 不在树上就用它
 * （它弹出去了，文件就进那个窗口，和从前一样）；再不然新开一格。
 *
 * 点一个路径打开文件，各处都走这一扇门，所以这一扇门把事办完：
 * - 标签叫磁盘上的文件名，不收调用方给的名字。面板按扩展名决定怎么画，附件标记上那个人起的名字
 *   没有扩展名，`.md` 就画不成文档。
 * - 读到了才开出那一格；读不到在这里说一声，说清读的是哪儿。从不 reject：调用方十来处，从前各自
 *   `.catch(notify)`，有一半没接。
 */
export function openFilePane(path: string, target?: string): Promise<void> {
	const file = { path, name: baseName(path) || path };
	if (inPanelWindow()) {
		if (bridge.windows?.openPanelInMain) void bridge.windows.openPanelInMain({ ...inMain("file", target), file });
		return Promise.resolve();
	}
	const scope = screenFor(target);
	if (!scope) return Promise.resolve();
	const dock = usePaneDock.getState();
	const tree = dock.tree(scope);
	const files = useOpenFile.getState();
	const panes = kinds(tree).filter((kind) => basePanelKind(kind) === "file");
	const showing = (kind: PaneKind) => {
		const open = openFileOf(files, fileSlot(scope, kind));
		return open.opening ?? open.path;
	};
	const kind =
		panes.find((each) => showing(each) === file.path) ??
		panes.find((each) => !showing(each)) ??
		nextPanelKind("file", (each) => has(tree, each));
	/*
	 * Read first, then show. A file that cannot be read does not leave an empty tab behind, and a
	 * pane already showing something keeps showing it.
	 */
	return files.open(fileSlot(scope, kind), file).then((shown) => {
		if (shown) openScopedPanel(kind as PanelKind, scope);
		else useApp.getState().notify(translate("filePanel.unreadableAt", { path: file.path }), "warn");
	});
}

// 会话里生成图的「在新标签页中打开」从这里进来，见 `provideFileOpener`。
provideFileOpener(openFilePane);

/**
 * 工具栏那排按钮、快捷键、标签条的「+」和「⋮」菜单：能开好几个的（终端、侧边聊天、文件、网页）再开一个，
 * 只能开一个的开着就切过去——右栏收着就展开，弹出去了就把那个窗口叫到前面。从不关，关只在标签上的 ✕
 * 和「⋮」菜单里。自己会开的（网页）交给它自己，见 `PanelDefinition.create`。
 *
 * 快捷键从前是开关：开着又在前台就关掉。关掉就是没了（`PanelDefinition.onClose`），顺手多按一下就把
 * 正在跑的 shell 结束了；能开好几个的面板，开关也开不出第二个。
 *
 * 「最早那一格占没占」连弹出去的也算：它不在树上，只问树会在右栏再开一个同样的 `chat`，
 * 两处画着同一段对话。
 */
export function showScopedPanel(scope: string, kind: PanelKind): void {
	const create = panelOf(kind)?.create;
	if (create) return create(scope);
	const tree = usePaneDock.getState().tree(scope);
	const next = allowsMany(kind) ? nextPanelKind(kind, (each) => has(tree, each) || isPopped(scope, each)) : kind;
	if (isPopped(scope, next)) {
		if (bridge.windows?.openPanel) void bridge.windows.openPanel({ kind: next, scope, sessionId: sessionOf(scope) });
		return;
	}
	usePaneDock.getState().open(scope, next);
}

/**
 * 拿一段话去侧边聊天时落在哪一格，返回那一格的侧边聊天 id。
 *
 * `reuse`：右栏前台正好是这个会话的一个侧边聊天，就接着用它——划了一段又一段，问的多半是同一件事，
 * 每段一个新标签会把右栏挤满。`/btw` 不接着用：它是一句新的旁问，而且会立刻发出去，接进一格正在答
 * 的侧边聊天只会排在后面。都不是就照工具栏按钮的规矩再开一格。
 *
 * 面板窗口里没有右栏，请求转给主窗口也拿不回是哪一格，返回 null。
 */
export function sideChatFor(scope: string, reuse: boolean): string | null {
	if (inPanelWindow()) return null;
	const dock = usePaneDock.getState();
	const tree = dock.tree(scope);
	const front = reuse && !dock.tabsCollapsed ? activeTab(tree, dock.tab[scope]) : null;
	const kind = front && sideIdOfPanel(front) ? front : nextPanelKind("chat", (each) => has(tree, each) || isPopped(scope, each));
	dock.open(scope, kind);
	return sideIdOfPanel(kind);
}

// 对话里划词「在侧边聊天中提问」从这里进来：引文挂到那一格的输入框上，问什么由人接着写。
provideSideQuote((sessionId, quote) => {
	const sideId = sideChatFor(sessionId, true);
	if (sideId) useSide.getState().seedQuote(sessionId, sideId, quote);
});

/**
 * 启动时发现的孤儿：盘上有回家记录，却没有对应的面板窗口。
 *
 * 这只有一种来法——人把面板弹出去，然后**没有收回就退出了应用**。窗口列表从来不存盘，所以
 * 重开之后那个面板既不在任何一棵树里（弹出时已经从树上删了），也没有窗口。那条记录记着它属于
 * 哪个会话，就照它放回那个会话的布局里——那个会话在屏上就回到原位，不在屏上就等它下次出现。
 *
 * 「人主动关掉那个面板窗口」不会走到这里：那一刻应用还活着，`apply` 当场就把记录清了。
 */
function adoptOrphans(): void {
	for (const key of Object.keys(readHomes())) {
		let cut = key.lastIndexOf(":");
		// 后开的那几格自己带一个冒号（`terminal:<id>`），键是 `<屏>:<种类>:<id>`。
		const before = key.lastIndexOf(":", cut - 1);
		if (before > 0 && allowsMany(key.slice(before + 1, cut))) cut = before;
		if (cut <= 0) continue;
		const scope = key.slice(0, cut);
		const kind = key.slice(cut + 1) as PanelKind;
		if (isPopped(scope, kind)) continue;
		void dockBack(kind, scope, false);
	}
}

export function watchPanelWindows(): () => void {
	if (!bridge.windows) return () => {};
	let first = true;
	const apply = (panels: PanelWindowRef[]) => {
		const before = usePanelWindows.getState().panels;
		usePanelWindows.setState((state) => ({ panels, opening: state.opening.filter((pending) => !panels.some((panel) => panel.scope === pending.scope && panel.kind === pending.kind)) }));
		if (first) {
			first = false;
			adoptOrphans();
			return;
		}
		/*
		 * 一个面板窗口不见了，而它不是被「收回」收走的——那条路自己会清记录，清完窗口才关。
		 * 剩下的就是人主动关掉了它：和在标签上点 ✕ 是一回事，面板不回来，它自己的东西一起放掉
		 * （`PanelDefinition.onClose`）。退出应用时主进程不报这一下，那些面板下次启动照记录放回来，
		 * 见 `adoptOrphans`。有没有记录就是分辨「收回」和「关掉」的那一下。
		 */
		for (const gone of before) {
			if (panels.some((panel) => panel.scope === gone.scope && panel.kind === gone.kind)) continue;
			const key = homeKey(gone.scope, gone.kind);
			if (!homes.get(key)) continue;
			homes.delete(key);
			panelOf(gone.kind as PanelKind)?.onClose?.(gone.scope, gone.kind as PanelKind);
		}
	};
	void bridge.windows
		.list()
		.then((result) => { if (first) apply(result.panels ?? []); })
		.catch(() => {});
	const stopChanged = bridge.windows.onChanged((state) => apply(state.panels ?? []));
	/*
	 * A panel window asking this window to open something, since only this one has docks.
	 *
	 * Deliberately the same `openScopedPanel` the local callers use, so a file opened from a
	 * detached tree lands exactly where one opened from the transcript would: in the screen the panel
	 * came from while that screen is here, and in the one with focus once it is not. The file is read
	 * through this window's own file boundary, as a click here would read it.
	 */
	const stopOpen = bridge.windows.onOpenPanel?.(({ kind, scope, file }) => {
		if (file && basePanelKind(kind) === "file") void openFilePane(file.path, scope);
		else openScopedPanel(kind as PanelKind, scope);
	}) ?? (() => {});
	const stopRestore = bridge.windows.onRestorePanel(({ kind, scope, fileState }) => {
		const restore = async () => {
			if (!(await dockBack(kind as PanelKind, scope, true))) return;
			if (fileState) await applyFilePanelState(fileSlot(scope, kind), fileState);
			await bridge.windows.closePanel({ kind, scope });
		};
		void restore().catch((error: unknown) => {
			// oxlint-disable-next-line no-console -- a failed handoff must keep the detached panel alive.
			console.error("Failed to restore panel", error);
		});
	});
	return () => {
		stopChanged();
		stopOpen();
		stopRestore();
	};
}
