/**
 * 面板的排法：所有面板收进对话右侧同一格，每个一个标签。
 *
 * 存的还是一棵树：打开、关闭、弹出、持久化照旧按树走，`has(tree, kind)` 在哪儿都还是「开着没有」，
 * 标签的先后就是树里的先后。画的时候只画当前那个，其余隐藏但不卸载——终端的 shell、浏览器的页面
 * 切标签不会重来。
 */

import { insert, kinds, leafOf, type DockNode, type PaneKind } from "./tree.ts";

/** 标签的顺序就是树的顺序：新开的面板落在最后，标签也排在最后。 */
export const panelsOf = (tree: DockNode): PaneKind[] => kinds(tree).filter((kind) => kind !== "conversation");

/** 把面板放成第 `index` 个标签；不给或超出就排在最后。 */
export function insertTab(tree: DockNode, kind: PaneKind, index = Number.POSITIVE_INFINITY): DockNode {
	const panels = panelsOf(tree);
	const at = Math.max(0, Math.min(index, panels.length));
	return at < panels.length
		? insert(tree, kind, { side: "left", kind: panels[at] })
		: insert(tree, kind, { side: "right", kind: panels.at(-1) ?? "conversation" });
}

/** 当前标签：记着的那个还开着就是它，否则是最后一个。一个面板都没开时为 null。 */
export function activeTab(tree: DockNode, remembered: PaneKind | undefined): PaneKind | null {
	const panels = panelsOf(tree);
	if (remembered && panels.includes(remembered)) return remembered;
	return panels.at(-1) ?? null;
}

/** 画的时候用的树：对话在左，当前标签在右，占 `share`。 */
export function tabbedTree(active: PaneKind | null, share: number): DockNode {
	if (!active) return leafOf("conversation");
	return { type: "split", dir: "row", children: [leafOf("conversation"), leafOf(active)], sizes: [1 - share, share] };
}

/**
 * 标签面板多宽，全窗口共用一份：它是「右边那一栏」，不是某个会话的布局。
 *
 * 存像素，不存占比。占比跟着这一屏的宽度走，左边侧栏一开一合右栏就跟着伸缩一百多像素，滑动时
 * 里面的输入框还要先跳到终点宽度。像素宽的右栏不动，变的只有对话那一格——和侧栏本身一样。
 */
const WIDTH_KEY = "dw:panedock:tab-width";
/** 从前存的占比。第一次量到这一屏多宽时折成像素，见 `DockView`。 */
const LEGACY_SHARE_KEY = "dw:panedock:tab-share";
const DEFAULT_SHARE = 0.4;
/** 两边都至少留这么多；再窄由 `fitTree` 按像素下限兜住。 */
const SHARE_LIMIT = 0.15;

export const clampTabShare = (share: number): number =>
	Number.isFinite(share) ? Math.min(1 - SHARE_LIMIT, Math.max(SHARE_LIMIT, share)) : DEFAULT_SHARE;

/** 还没定过像素宽时为 null。 */
export function readTabWidth(): number | null {
	try {
		const width = Number(window.localStorage.getItem(WIDTH_KEY) ?? Number.NaN);
		return Number.isFinite(width) && width > 0 ? width : null;
	} catch {
		return null;
	}
}

/** 还没有像素宽时用的占比：旧版存下的，没有就是默认。 */
export function legacyTabShare(): number {
	try {
		const raw = window.localStorage.getItem(LEGACY_SHARE_KEY);
		return raw === null ? DEFAULT_SHARE : clampTabShare(Number(raw));
	} catch {
		return DEFAULT_SHARE;
	}
}

/** 右侧那一栏收起来没有，和宽度一样全窗口一份、重开还在：它是「右边那一栏」的状态，不是某个会话的。 */
const COLLAPSED_KEY = "dw:panedock:tabs-collapsed";

export function readTabsCollapsed(): boolean {
	try {
		return window.localStorage.getItem(COLLAPSED_KEY) === "1";
	} catch {
		return false;
	}
}

export function writeTabsCollapsed(collapsed: boolean): void {
	try {
		if (collapsed) window.localStorage.setItem(COLLAPSED_KEY, "1");
		else window.localStorage.removeItem(COLLAPSED_KEY);
	} catch {
		// 存储关了，这次会话里照样收着，下次回到展开。
	}
}

export function writeTabWidth(width: number): void {
	try {
		window.localStorage.setItem(WIDTH_KEY, String(width));
		window.localStorage.removeItem(LEGACY_SHARE_KEY);
	} catch {
		// 存储关了，这次会话里照样按拖到的宽度画，下次回到默认宽度。
	}
}
