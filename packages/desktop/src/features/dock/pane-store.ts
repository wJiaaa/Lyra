/**
 * 面板布局——每个会话一份，而且只有这一份。
 *
 * 面板（终端、浏览器、文件、Git、任务……）属于会话，不属于窗口。窗口里只有会话的网格：单屏是
 * 只有一屏的分屏，每一屏画的都是「这个会话的对话 + 它自己的面板」。所以这里的每棵树都挂在一个
 * scope 下，scope 就是那一屏的会话 id（空白对话是 `@draft`）。
 *
 * 从前有两层都能装面板：窗口一层跨着所有屏，每一屏又各有一层。两层之间靠一串特例对齐——「已经在
 * 窗口层的留在那儿」「分屏时窗口层冻结在进入分屏的那个会话」「浏览器页面按焦点在两层之间交接」——
 * 每条修一个症状，又在别处埋一个：任务面板分屏后横跨两屏、回到单屏的面板压在标题栏下面、打开
 * 网址冒出第二个浏览器、切一次焦点页面重载一次。架构决定见 `docs/adr/0023-containers-belong-to-sessions.md`。
 *
 * 这个文件只管数据：树、全屏、窄窗口时正显示哪一块、当前标签。画成什么样是 `DockView` 的事。
 */

import { create } from "zustand";
import { dropTree, flushTree, paneStorageKey, readTree, writeTree } from "./persist.ts";
import { clampTabShare, insertTab, panelsOf, readTabsCollapsed, readTabShare, writeTabsCollapsed, writeTabShare } from "./tabs.ts";
import { panelInstance } from "../../lib/panel-instance.ts";
import { panelOf } from "./panels/registry.ts";
import { defaultTree, has, kinds, remove, type DockNode, type PaneKind } from "./tree.ts";

export const emptyDockTree: DockNode = defaultTree();

type Span = { width: number; height: number };

interface PaneDockState {
	trees: Record<string, DockNode>;
	/** Each live screen's measured size. A scope with no size is not on screen right now. */
	sizes: Record<string, Span>;
	/** 这一屏的右栏铺满了整屏。全屏的是整栏，不是某个标签：切标签、开新标签都还在全屏里。 */
	maximized: Record<string, boolean>;
	/** Which pane the narrow layout is showing, and which one the keyboard is on. */
	focused: Record<string, PaneKind>;
	/** 每一屏最后看的那个面板。见 `tabs.ts`。 */
	tab: Record<string, PaneKind>;
	/** 右侧那一栏占多宽，全窗口一份。 */
	tabShare: number;
	/**
	 * 右侧那一栏收起来了：面板都还开着、还挂着，只是不画。全窗口一份。
	 * 只在单屏起作用——收起后开关在窗口顶栏里，分屏时每格的标题栏里没有它，见 `DockView`。
	 */
	tabsCollapsed: boolean;
	/**
	 * Which screen's browser hosts the pages nobody else is showing.
	 *
	 * Set by the workspace: the screen that has been on screen longest. See `useBrowserPages`.
	 */
	host: string | null;

	tree(scope: string): DockNode;
	size(scope: string): Span | undefined;
	/**
	 * Read this scope's layout back, the first time a screen shows it.
	 *
	 * `draftFrom` names the blank conversation this one was just sent from: a draft that was
	 * arranged and then given an id keeps the panes it was arranged with.
	 */
	hydrate(scope: string, allowed: PaneKind[], options?: { draftFrom?: string }): void;
	forget(scope: string): void;
	rememberSize(scope: string, span: Span): void;
	setHost(scope: string | null): void;
	/** `index`：放成第几个标签，收回弹出的面板时用；不给就排在最后。 */
	open(scope: string, kind: PaneKind, index?: number): boolean;
	close(scope: string, kind: PaneKind): void;
	/** Put a panel away wherever it is open. For the panels whose contents are one shared thing. */
	closeEverywhere(kind: PaneKind): void;
	focus(scope: string, kind: PaneKind): void;
	setTabShare(share: number): void;
	setTabsCollapsed(collapsed: boolean): void;
	restoreLayout(scope: string, tree: DockNode): void;
	toggleMaximized(scope: string): void;
	/** Leave full screen. */
	restore(scope: string): void;
}

/** Write to memory, and through to disk — a bare conversation is "nothing stored", not a row. */
function persist(scope: string, tree: DockNode): void {
	if (tree.type === "leaf" && tree.kind === "conversation") dropTree(paneStorageKey(scope));
	else writeTree(paneStorageKey(scope), tree);
}

const isBare = (tree: DockNode | null | undefined): boolean => !tree || (tree.type === "leaf" && tree.kind === "conversation");

export const usePaneDock = create<PaneDockState>((set, get) => {
	/** Every structural change goes through here, so nothing changes a tree without saving it. */
	const commit = (scope: string, tree: DockNode, extra?: { focused?: PaneKind; maximized?: boolean }) => {
		const state = get();
		const present = kinds(tree);
		const focused = extra?.focused ?? state.focused[scope] ?? "conversation";
		// 最后一个面板关掉了，右栏没了，全屏也就结束。
		const maximized = (extra?.maximized ?? state.maximized[scope] ?? false) && panelsOf(tree).length > 0;
		const tab = focused !== "conversation" && present.includes(focused) ? { ...state.tab, [scope]: focused } : state.tab;
		set({
			tab,
			trees: { ...state.trees, [scope]: tree },
			// A pane that left the tree cannot go on being the focused one.
			focused: { ...state.focused, [scope]: present.includes(focused) ? focused : "conversation" },
			maximized: { ...state.maximized, [scope]: maximized },
		});
		persist(scope, tree);
	};

	return {
		trees: {},
		sizes: {},
		maximized: {},
		focused: {},
		tab: {},
		tabShare: readTabShare(),
		tabsCollapsed: readTabsCollapsed(),
		host: null,

		tree: (scope) => get().trees[scope] ?? emptyDockTree,
		size: (scope) => get().sizes[scope],

		hydrate(scope, allowed, options) {
			// Memory is newer than disk: a screen that remounts keeps what it had.
			if (get().trees[scope]) return;
			const stored = readTree(paneStorageKey(scope), allowed);
			let tree = isBare(stored) ? null : stored;
			/*
			 * 空白对话发出第一条消息、拿到 id 的那一下。
			 *
			 * 人常在开口之前先把面板摆好——那正是准备干活的时候。这时新 id 名下什么都没有，读新钥匙
			 * 只会读到空，刚摆好的布局就被扔了。只在调用方明说「这是刚从空白对话变来的」时才搬：
			 * 点开一个本来就存在、只是没存过布局的会话，看起来一模一样，却不该继承草稿的面板。
			 */
			if (!tree && options?.draftFrom) {
				const draft = get().trees[options.draftFrom] ?? readTree(paneStorageKey(options.draftFrom), allowed);
				if (!isBare(draft)) tree = draft;
			}
			if (!tree || isBare(tree)) return;
			set({ trees: { ...get().trees, [scope]: tree } });
			persist(scope, tree);
		},

		forget(scope) {
			/*
			 * 只忘掉内存里那份，盘上的留着。
			 *
			 * `forget` 是这一屏从界面上消失时调的，而那既可能是关掉了这一屏，也可能只是刷新或者
			 * 这一格换了会话。盘上那份一起删掉，就等于「刷新一次布局就没了」。
			 */
			flushTree();
			set((state) => {
				if (!(scope in state.trees) && !(scope in state.sizes)) return state;
				const trees = { ...state.trees };
				const sizes = { ...state.sizes };
				const maximized = { ...state.maximized };
				const focused = { ...state.focused };
				const tab = { ...state.tab };
				delete tab[scope];
				delete trees[scope];
				delete sizes[scope];
				delete maximized[scope];
				delete focused[scope];
				return { trees, sizes, maximized, focused, tab };
			});
		},

		rememberSize(scope, span) {
			if (!(span.width > 0) || !(span.height > 0)) return;
			const current = get().sizes[scope];
			if (current && current.width === span.width && current.height === span.height) return;
			set({ sizes: { ...get().sizes, [scope]: span } });
		},

		setHost(scope) {
			if (get().host !== scope) set({ host: scope });
		},

		/** Open a pane, or bring it forward if it is already open. */
		open(scope, kind, index) {
			// 要一个面板就是要看它：右栏收着的话先展开，否则点了终端什么也看不见。
			get().setTabsCollapsed(false);
			const tree = get().tree(scope);
			if (has(tree, kind)) {
				get().focus(scope, kind);
				return true;
			}
			commit(scope, insertTab(tree, kind, index), { focused: kind });
			return true;
		},

		close(scope, kind) {
			const state = get();
			const tree = state.tree(scope);
			if (!has(tree, kind)) return;
			// 关掉的是当前标签，就落到它右边那个，没有再往左——和浏览器关标签一样。
			if (state.tab[scope] === kind) {
				const panels = panelsOf(tree);
				const at = panels.indexOf(kind);
				const next = panels[at + 1] ?? panels[at - 1];
				const tab = { ...state.tab };
				if (next) tab[scope] = next;
				else delete tab[scope];
				set({ tab });
			}
			commit(scope, remove(tree, kind));
		},

		closeEverywhere(kind) {
			for (const [scope, tree] of Object.entries(get().trees)) {
				if (has(tree, kind)) get().close(scope, kind);
			}
		},

		// Guarded: this runs on every pointer-down inside a pane.
		focus(scope, kind) {
			const state = get();
			const panel = kind !== "conversation";
			if (state.focused[scope] === kind && (!panel || state.tab[scope] === kind)) return;
			set({
				focused: { ...state.focused, [scope]: kind },
				...(panel ? { tab: { ...state.tab, [scope]: kind } } : null),
			});
		},

		setTabShare(share) {
			const next = clampTabShare(share);
			if (Math.abs(next - get().tabShare) < 1e-6) return;
			set({ tabShare: next });
			writeTabShare(next);
		},

		setTabsCollapsed(collapsed) {
			if (get().tabsCollapsed === collapsed) return;
			set({ tabsCollapsed: collapsed });
			writeTabsCollapsed(collapsed);
		},

		restoreLayout(scope, tree) {
			commit(scope, tree, { maximized: false });
		},

		/** 右栏铺满这一屏，或者退回来。只动这一屏：窗口里另一段对话不受影响。 */
		toggleMaximized(scope) {
			const state = get();
			if (state.maximized[scope]) {
				get().restore(scope);
				return;
			}
			if (panelsOf(state.tree(scope)).length === 0) return;
			set({ maximized: { ...state.maximized, [scope]: true } });
		},

		restore(scope) {
			if (!get().maximized[scope]) return;
			set({ maximized: { ...get().maximized, [scope]: false } });
		},
	};
});

/**
 * 人点了 ✕：关掉这一格。
 *
 * 和 `usePaneDock.close` 分开，因为那个也是弹出窗口时把面板从树里拿走的那一步，不能带副作用。
 * 后开的那几格关掉就没了，手上的东西交给面板自己收——见 `PanelDefinition.closeInstance`。
 */
export function closePane(scope: string, kind: PaneKind): void {
	usePaneDock.getState().close(scope, kind);
	const instance = panelInstance(kind);
	if (instance) panelOf(kind)?.closeInstance?.(scope, instance);
}

/**
 * Save on the way out.
 *
 * The write is debounced, so a change made in the last tenth of a second before the window closes
 * would otherwise be the one change that never survives — and that is exactly the change someone
 * would notice, because it is the one they just made.
 */
if (typeof window !== "undefined") window.addEventListener("beforeunload", flushTree);
