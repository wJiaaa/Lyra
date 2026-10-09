/**
 * One conversation's screen: its transcript and the panels it has open, arranged by its own tree.
 *
 * Every screen is drawn by this — a single screen is a split of one. There is no window-level dock
 * any more: a panel belongs to the conversation it was opened for, sits inside that conversation's
 * screen at the screen's full height, and goes wherever the conversation goes. The screen's title
 * bar (`header`) covers the transcript only, never a panel beside it. See
 * `docs/adr/0023-containers-belong-to-sessions.md` for the two-layer arrangement this replaced.
 *
 * Two rules hold this together, and both exist to keep a pane's contents alive across a
 * rearrangement — a terminal's shell, a page in the browser, an editor's undo history.
 *
 * **One flat list of panes, positioned absolutely.** Never a recursive render of the tree; see the
 * note at the top of `layout.ts`.
 *
 * **One DOM shape for every window size.** The narrow form is the same panes, each laid over the
 * whole screen with all but one hidden — not a different component. A layout that swaps its
 * structure at a breakpoint unmounts everything inside it.
 */

import { translate } from "../../i18n/translate.ts";
import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";

import { useLayout } from "../../app/layout.tsx";
import { SidebarIcon, ToolbarButton, toolbarReserved } from "../../app/window/WindowControls.tsx";
import { freezeMotion } from "../../ui/motion/freeze.ts";
import { useApp } from "../../store/index.ts";
import { renderPanel, renderPanelActions, renderPanelHeader, usePanelDefinitions } from "./panels/definitions.tsx";
import { cardRoom, HEADER_PAD, paneFloor } from "./geometry.ts";
import { DockPane } from "./DockPane.tsx";
import { Splitter } from "./Splitter.tsx";
import { fitTree, layoutPanes, layoutSplitters, type Box } from "./layout.ts";
import { popOutPanel } from "./popout.ts";
import { emptyDockTree, usePaneDock } from "./pane-store.ts";
import { allowsMany, basePanelKind } from "../../lib/panel-instance.ts";
import { DockScope } from "../../app/session-scope.tsx";
import { canToggleMaximized } from "./visibility.ts";
import type { PanelKind } from "./sideStore.ts";
import { kinds, type PaneKind } from "./tree.ts";
import { detachOf } from "./panels/registry.ts";
import { useBoxSize } from "./useBoxSize.ts";
import { useColumnSlide } from "./column-slide.ts";
import { activeTab, clampTabShare, legacyTabShare, panelsOf, tabbedTree } from "./tabs.ts";
import { PanelTabs, type AddablePanel, type PanelTab } from "./PanelTabs.tsx";

const WHOLE: Box = { left: 0, top: 0, width: 1, height: 1 };

/** Room this screen has to leave at its corners of the window, for what the system draws there. */
export interface ScreenInsets {
	/** The traffic lights and the sidebar toggle, when this screen holds the window's top-left. */
	start: number;
	/** Windows and Linux caption buttons, when this screen holds the window's top-right. */
	end: number;
}

/**
 * How far a pane's title must start in when it holds the window's top-left corner.
 *
 * What it has to leave clear is whatever the system drew there *and* the sidebar toggle beside it.
 * `toolbarReserved` is measured from the window's edge; a pane at the left edge is flush with it, so
 * what stands between the two is the header's own padding — subtract that and what is left is the
 * extra the header has to add. The toggle used not to be counted, and with the sidebar closed it is
 * the only way back.
 */
export function cornerReserved(start: number): number {
	return toolbarReserved(start) - HEADER_PAD - 1;
}

/**
 * How much the screen at the window's top-left must reserve.
 *
 * Nothing while the sidebar is open — it covers that corner and draws the toggle itself — and
 * nothing on Windows and Linux, whose header band takes both ends of the window once for everyone.
 * **Native full screen does not excuse it**: full screen takes the traffic lights away, not the
 * toggle, which stays and is the only way back with the sidebar closed. What full screen changes is
 * how much — `titlebarInsets` drops `start` from 86 to 12.
 */
export function startInset({ headerBar, navOpen, start }: { headerBar: boolean; navOpen: boolean; start: number }): number {
	return headerBar || navOpen ? 0 : cornerReserved(start);
}

/**
 * Which pane of a screen is drawn at a corner — the one that has to make room there.
 *
 * Asked of where panes are *drawn*, not of where the tree keeps them: full screen moves a pane to
 * the origin without touching the tree. The narrow layout shows one pane over the whole screen, so
 * that pane is every corner.
 */
export function paneAtCorner({
	compact,
	focusedPane,
	boxes,
	corner,
}: {
	compact: boolean;
	focusedPane: PaneKind;
	boxes: (Box & { kind: PaneKind })[];
	corner: "start" | "end";
}): PaneKind | null {
	if (compact) return focusedPane;
	const hit = boxes.find((box) =>
		corner === "start" ? box.left <= 1e-6 && box.top <= 1e-6 : box.top <= 1e-6 && Math.abs(box.left + box.width - 1) < 0.001,
	);
	return hit?.kind ?? null;
}

/*
 * Adopting a layout is not a movement, so it does not animate — and several screens may adopt in
 * the same frame. Counted, so one screen finishing does not lift the flag under another.
 */
let settling = 0;
function settle(): () => void {
	const thaw = freezeMotion();
	settling++;
	document.documentElement.dataset.dockSettling = "";
	let done = false;
	return () => {
		if (done) return;
		done = true;
		thaw();
		settling--;
		if (settling === 0) delete document.documentElement.dataset.dockSettling;
	};
}

const sessionOf = (scope: string): string | null => (scope === "@draft" ? null : scope);

/** A screen that holds neither corner of the window reserves nothing. */
const NO_INSETS: ScreenInsets = { start: 0, end: 0 };

export function DockView({
	scope,
	header,
	foldable = false,
	insets = NO_INSETS,
	children,
}: {
	/** The conversation this screen shows — its session id, or `@draft` for the blank one. */
	scope: string;
	/**
	 * The conversation's own title bar, given the insets it owes the window's corners, and what to put
	 * at the end of its buttons — the toggle that brings a folded panel column back.
	 */
	header: (insets: ScreenInsets, after?: ReactNode) => ReactNode;
	/**
	 * The panel column can be folded away: the only screen. Not with several screens —
	 * whether the column is folded is one setting for the window, and a toggle in one screen would
	 * fold them all.
	 */
	foldable?: boolean;
	insets?: ScreenInsets;
	/** The transcript and composer. */
	children: ReactNode;
}) {
	const tree = usePaneDock((s) => s.trees[scope] ?? emptyDockTree);
	const maximized = usePaneDock((s) => s.maximized[scope] ?? false);
	const focusedPane = usePaneDock((s) => s.focused[scope] ?? "conversation");
	const rememberedTab = usePaneDock((s) => s.tab[scope]);
	const tabWidth = usePaneDock((s) => s.tabWidth);
	const tabsCollapsed = usePaneDock((s) => s.tabsCollapsed);
	const { compact } = useLayout();
	const definitions = usePanelDefinitions();
	const containerRef = useRef<HTMLDivElement>(null);
	const size = useBoxSize(containerRef);

	/*
	 * Read this conversation's layout back — in a layout effect, because reading storage is
	 * synchronous and an ordinary effect would paint the default layout for a frame first, the panes
	 * then snapping into place.
	 *
	 * `definitions` is rebuilt on every render, so it is read through a ref: only its contents
	 * (which kinds are loadable) matter here, never its identity.
	 */
	const allowed = useRef<PaneKind[]>([]);
	allowed.current = ["conversation", ...definitions.filter((def) => !def.ephemeral).map((def) => def.kind)];
	const previousScope = useRef<string | null>(null);
	useLayoutEffect(() => {
		const from = previousScope.current;
		previousScope.current = scope;
		const settled = settle();
		// Only a blank conversation that has just been *sent* keeps its panes under the new id — see
		// `draftBecame`. Clicking an existing conversation from a blank one looks the same here.
		const sent = from === "@draft" && scope !== "@draft" && useApp.getState().draftBecame === scope;
		usePaneDock.getState().hydrate(scope, allowed.current, sent ? { draftFrom: "@draft" } : undefined);
		const frame = requestAnimationFrame(() => {
			requestAnimationFrame(settled);
		});
		return () => {
			cancelAnimationFrame(frame);
			settled();
		};
	}, [scope]);

	useLayoutEffect(() => {
		if (size) usePaneDock.getState().rememberSize(scope, size);
	}, [scope, size]);
	useEffect(() => () => usePaneDock.getState().forget(scope), [scope]);

	// 右栏还没有像素宽（头一次打开、或旧版只存了占比）：按这一屏眼下的宽度定下来，之后就不再跟着变。
	useLayoutEffect(() => {
		if (tabWidth === null && size) usePaneDock.getState().setTabWidth(legacyTabShare() * size.width);
	}, [tabWidth, size]);

	/*
	 * 画的是「对话 + 当前标签」这棵两格的树，其余面板借当前标签的位置、隐藏着挂在那儿。存的树不动，
	 * 见 `tabs.ts`。`fitted` 是按这一屏的尺寸量过的那棵：画不下下限时照画，行首那格被盖住而不是重排。
	 */
	const panels = panelsOf(tree);
	const tab = activeTab(tree, rememberedTab);
	const tabShare = clampTabShare(size && tabWidth !== null ? tabWidth / size.width : legacyTabShare());
	/*
	 * 标题栏、标签条和收起右栏的开关都在各自的卡片里，单屏也一样。它们曾经上到窗口顶栏（2026-10-07），
	 * 可顶栏里有没有东西要看开着什么：插件、设置这类页面、没开右栏时，顶栏那一大段就空着。
	 *
	 * 开关展开时在这一栏的按钮最后，收起时在会话标题栏的按钮最后。窄窗口下一格盖满整屏、放不下并排而
	 * 面板排到对话下面时没有右边这一栏，也就没有这颗开关。
	 */
	const pair = !compact && size && tab ? fitTree(tabbedTree(tab, tabShare), size, paneFloor) : null;
	const stacked = pair?.type === "split" && pair.dir === "col";
	const canFold = foldable && !compact && !stacked;
	/*
	 * 右栏收起：画的树里只剩对话，面板照旧挂着（隐藏），展开时终端、页面都还在。只在有开关时算数——
	 * 分屏或窄窗口下没有它，收着就再也打不开了。
	 */
	const folded = canFold && tabsCollapsed && tab !== null;
	const shown = tabbedTree(folded ? null : tab, tabShare);
	/** 一个标签借谁的格子画：所有面板都在当前标签那一格。 */
	const slotOf = (kind: PaneKind): PaneKind => (tab && panels.includes(kind) ? tab : kind);
	const fitted = compact || !size ? shown : fitTree(shown, size, paneFloor);
	const laid = layoutPanes(fitted);
	const openBoxes = pair && tab ? layoutPanes(pair) : [];
	const openConversation = openBoxes.find((box) => box.kind === "conversation");
	const openPanel = openBoxes.find((box) => box.kind === tab);
	/*
	 * 只在有收起开关的那一屏滑：分屏时面板从这一屏右边滑进来，会从隔壁那一屏上面扫过去；
	 * 上下排的时候也不是从右边进来。这两种照旧原地淡入，见下面的 `quietEntrance`。
	 */
	const slides = canFold && openConversation && openPanel ? { conversation: openConversation, panel: openPanel } : null;
	useColumnSlide(containerRef, scope, tab, folded, slides);

	// 全屏的是整栏，不是某一个标签：切标签不该退出全屏。
	const focus = !compact && tab && !folded && maximized ? tab : null;
	const focusBox = (kind: PaneKind): Box | null => (focus === kind ? WHOLE : null);
	const boxes = focus ? laid.filter((box) => box.kind === focus) : laid;

	// 那条分隔线的近侧是对话，标签栏拿剩下的。
	const applyShare = (share: number) => {
		if (size) usePaneDock.getState().setTabWidth(clampTabShare(1 - share) * size.width);
	};
	const splitters = compact || focus ? [] : layoutSplitters(fitted);

	/*
	 * 并排时右栏从右边量、写成像素：侧栏开合、拖窗口时这一屏变宽变窄，浏览器直接让对话那一格吸收，
	 * 右栏原地不动。写成占比的话，要等量到新尺寸、重渲染一遍才改回来——每一帧都慢一拍，而且样式
	 * 一变 `PaneSurface` 就当成一次挪动去补间。像素取自排过下限的那棵，挤到下限时照旧由 `fitTree` 定。
	 */
	const docked = !compact && !focus && size && fitted.type === "split" && fitted.dir === "row" ? laid.find((box) => box.kind !== "conversation") : undefined;
	const anchored = docked ? Math.round(docked.width * size!.width * 100) / 100 : null;
	const across = (box: Box): { left: string; width: string } | undefined => {
		// 整屏大小的那一格（藏着的浏览器）不在这一行里。
		if (anchored === null || box.width > 1 - 1e-6) return undefined;
		return box.left < 1e-6 ? { left: "0%", width: `calc(100% - ${anchored}px)` } : { left: `calc(100% - ${anchored}px)`, width: `${anchored}px` };
	};

	/*
	 * The order panes are *mounted* in, which is not the order they are laid out in.
	 *
	 * Moving an <iframe> or a <webview> in the DOM reloads it, so new panes are appended and an
	 * existing pane's node is only ever removed, never relocated. The browser is always mounted,
	 * hidden when closed: its pages keep running while the panel is put away, and opening it again
	 * shows them without a reload. Assigned during render and idempotent.
	 */
	const order = useRef<PaneKind[]>(["conversation", "browser"]);
	// 后台标签不在画的树里，但仍要挂着——它们就是被隐藏的那些 pane。
	const present = kinds(tree);
	order.current = [
		...order.current.filter((kind) => present.includes(kind) || kind === "browser"),
		...present.filter((kind) => !order.current.includes(kind)),
	];

	const at = (box: Box & { kind: PaneKind }) => ({ ...box, ...focusBox(box.kind) });
	const drawn = boxes.map(at);
	const startCorner = insets.start > 0 ? paneAtCorner({ compact, focusedPane, boxes: drawn, corner: "start" }) : null;
	const endCorner = insets.end > 0 ? paneAtCorner({ compact, focusedPane, boxes: drawn, corner: "end" }) : null;
	const conversationLabel = translate("sidebar.chats");
	/** 标签上画的名字：能开好几个的面板各写各的，见 `PanelDefinition.tabTitle`。 */
	const titleOf = (kind: PaneKind, label: string): ReactNode => {
		const Title = definitions.find((entry) => entry.kind === basePanelKind(kind))?.tabTitle;
		return Title ? <Title scope={scope} kind={kind} fallback={label} /> : undefined;
	};
	const maximizeOf = (kind: PaneKind): (() => void) | undefined =>
		!canToggleMaximized(kind, { compact, maximized })
			? undefined
			: () => usePaneDock.getState().toggleMaximized(scope);
	const popOutOf = (kind: PaneKind): (() => void) | undefined =>
		kind === "conversation" || detachOf(kind) === "none"
			? undefined
			: () => void popOutPanel({ scope, kind: kind as PanelKind, sessionId: sessionOf(scope) });
	const tabs: PanelTab[] = panels.map((kind) => {
		const def = definitions.find((entry) => entry.kind === basePanelKind(kind));
		const label = def ? translate(def.label) : kind;
		return { kind, label, icon: def ? <def.icon size={12.5} strokeWidth={1.8} /> : undefined, title: titleOf(kind, label) };
	});
	// 和顶栏「⋮」菜单同一个口径：开不了的、不在菜单里列的都不给。能开好几个的开着也还能再开一个。
	const addable: AddablePanel[] = definitions
		.filter((def) => !def.unavailable && def.listed !== false && (allowsMany(def.kind) || !panels.includes(def.kind)))
		.map((def) => ({ kind: def.kind, label: translate(def.label), icon: <def.icon size={16} strokeWidth={1.7} />, shortcut: def.shortcut }));

	/** 收起、展开右栏。展开时这一栏标题栏里的小按钮，收起时会话标题栏里和旁边一样大的那颗。 */
	const toggleColumn = () => {
		const dock = usePaneDock.getState();
		// 全屏的是这一栏；收起它也就不再全屏，展开回来是平常的样子。
		if (!folded && dock.maximized[scope]) dock.restore(scope);
		dock.setTabsCollapsed(!folded);
	};
	const foldButton = canFold && tab && !folded ? (
		<ToolbarButton label={translate("pane.hideColumn")} onClick={toggleColumn}>
			<SidebarIcon side="right" open />
		</ToolbarButton>
	) : undefined;
	const unfoldButton = folded ? (
		<ToolbarButton label={translate("pane.showColumn")} onClick={toggleColumn}>
			<SidebarIcon side="right" open={false} />
		</ToolbarButton>
	) : undefined;

	return (
		<DockScope.Provider value={scope}>
			<div className="ly-dock relative flex min-h-0 min-w-0 flex-1 flex-col">
				{/* Marked so the dock's box can be measured from outside — see `e2e/dock.test.ts`. */}
				<div ref={containerRef} data-dock-panes={scope} data-ly-pane-dock={scope} className="relative min-h-0 min-w-0 flex-1">
					{splitters.map((handle) => (
						<Splitter
							key={`${handle.path.join(".")}:${handle.index}`}
							handle={handle}
							containerRef={containerRef}
							onResize={applyShare}
							onEven={() => applyShare(0.5)}
							at={anchored === null ? undefined : `calc(100% - ${anchored}px)`}
						/>
					))}

					{order.current.map((kind) => {
						const placed = boxes.find((box) => box.kind === kind);
						if (!placed && !present.includes(kind) && kind !== "browser") return null;
						const conversation = kind === "conversation";
						const base = basePanelKind(kind);
						const def = definitions.find((entry) => entry.kind === base);
						const label = conversation ? conversationLabel : def ? translate(def.label) : kind;
						const icon = !conversation && def ? <def.icon size={12.5} strokeWidth={1.8} /> : undefined;
						const slot = slotOf(kind);
						const box = compact ? WHOLE : (focusBox(slot) ?? laid.find((entry) => entry.kind === slot) ?? WHOLE);
						const panelHeader = conversation ? null : renderPanelHeader(kind as PanelKind);
						const inset = startCorner === kind ? insets.start : 0;
						const insetEnd = endCorner === kind ? insets.end : 0;
						return (
							<DockPane
								key={kind}
								kind={kind}
								box={box}
								across={across(box)}
								label={label}
								icon={icon}
								maximized={Boolean(focus) && Boolean(placed)}
								hidden={compact ? kind !== focusedPane : !placed}
								/*
								 * 新开一个标签，是在这一栏正显示着的那一格上顶替它：旧的那格立刻透明，
								 * 新的那格要是再从透明淡入，中间 150ms 整栏（连同标签条）都是空的，看着就是闪了一下。
								 * 这一栏本来就有面板时不淡入。从无到有（第一个面板）是真的出现：能滑的时候由
								 * `column-slide.ts` 从右边滑进、淡入，这里再起一段淡入会盖过它——CSS 过渡在层叠里
								 * 比 WAAPI 动画优先；滑不了的时候照旧淡入。
								 */
								quietEntrance={!conversation && (panels.length > 1 || slides !== null)}
								actions={conversation ? undefined : renderPanelActions(kind as PanelKind)}
								after={kind === tab ? foldButton : undefined}
								title={conversation ? undefined : <PanelTabs scope={scope} tabs={tabs} addable={addable} current={kind} />}
								inset={inset}
								insetEnd={insetEnd}
								onToggleMaximized={maximizeOf(kind)}
								onPopOut={popOutOf(kind)}
								onFocus={() => usePaneDock.getState().focus(scope, kind)}
								// A card, like every pane — see `DockPane`.
								customHeader={conversation ? <>{header({ start: cardRoom(inset), end: cardRoom(insetEnd) }, unfoldButton)}</> : undefined}
							>
								{conversation ? (
									children
								) : (
									/*
									 * 标题栏让给了标签条，面板自己的标题控件（文件的路径、交付的文件名）挪到它下面一行。
									 */
									<>
										{panelHeader && (
											<div data-dock-subheader={kind} className="flex shrink-0 items-center px-2 pb-1">
												{panelHeader}
											</div>
										)}
										<div className="relative flex min-h-0 min-w-0 flex-1 flex-col">{renderPanel(kind as PanelKind)}</div>
									</>
								)}
							</DockPane>
						);
					})}
				</div>
			</div>
		</DockScope.Provider>
	);
}
