/**
 * 右栏收起、展开，照左边侧栏开合的样子动：面板保持自己的宽度从右边滑进，对话那一格跟着
 * 让出（收起时跟着补上）同样的宽度，两边同一条曲线、同一段时长。侧栏是
 * `NavPane` 的 margin 过渡，这里是同一件事的镜像。对话里的正文只跟着这一格的宽度排版，这里不碰它；
 * 宽度变了阅读位置不动，由滚动区自己管（`ui/scroll/useFollowBottom.ts`）。
 *
 * 面板一路不透明，不像侧栏那样淡入淡出。侧栏本身是透明的，淡不淡底下都是窗口；面板是一张深色卡片，
 * 它底下也是窗口（`.ly-dock` 透明），开着毛玻璃时那层比卡片亮一截——暗色下卡片 #171717、窗口
 * #2b2b2b——一淡就整块泛灰。接缝也贴不严：对话的宽度在主线程上补间，正文一长就跟不上合成器上的
 * 平移，收起时两条边之间拉开上百像素，露出的同样是窗口。所以滑动期间在面板那一栏垫一块卡片底色
 * （`data-dock-sliding`，见 `dock.css`），滑完撤掉，平时卡片之间照旧露窗口。
 *
 * 面板收起只是藏起来（`[inert]` 立刻透明，展开回来也不过渡，见 `dock.css`），对话那一格的宽度
 * 由布局一步写到终点（`PaneSurface` 不缩放角上不动的格子）。所以这两段都要由这里从起点画过去。
 *
 * 只认人切换收起、展开（`tabsCollapsed` 变了）的那一下。`folded` 还会因为别的变：切回一个会话时，
 * 头一帧它的布局还没从盘上读回来、没有当前标签，`folded` 是假，读回来那一帧才变真——同一屏、
 * 什么也没点，却被当成刚点了收起，面板整个亮出来再滑走，看着就是「打开了又闪一下关上」。
 *
 * 这一栏从无到有（一个标签都没有时开了第一个）也是展开，照同一段画。它不经过 `folded`，原先对话
 * 一帧缩掉 466px、正文当场重排，面板再在原地淡入，中间右边空着一块。读回布局时当前标签同样是从
 * 无到有，那时挂着 `data-dock-settling`（`DockView` 的 `settle`），不算。
 *
 * 关掉最后一个面板是收起，也照同一段画。面板一关就卸载，没东西可滑，所以 `closePane` 先只把它
 * 标成正在离开（`leaving`），`DockView` 把这一下当成收起来画，滑完由这里真关。滑不了（分屏、
 * 窄窗口、减少动态效果）就当场关。
 */

import { useLayoutEffect, useRef, type RefObject } from "react";
import { motionReduced } from "../../ui/motion/reduced.ts";
import { DURATION } from "../../ui/motion/tokens.ts";
import { pct } from "./css.ts";
import { PANE_INSET } from "./geometry.ts";
import { closeNow, usePaneDock } from "./pane-store.ts";
import type { Box } from "./layout.ts";
import type { PaneKind } from "./tree.ts";

/** `NavPane` 的 Tailwind `ease-out`：两边同一条曲线。 */
const EASE_OUT = "cubic-bezier(0, 0, 0.2, 1)";

/** 会话标题栏末尾那颗「展开右栏」按钮（`DockView` 的 `data-dock-unfold`）占的地方。 */
interface Tail {
	holder: HTMLElement;
	/** 装它的那一排按钮。按钮卸掉了这一排还在，展开时在它右边垫出同样宽的空。 */
	row: HTMLElement;
	/** 按钮本身和它前面的间距。量里面那层：外面那层正被补间时宽度不作数。 */
	width: number;
	gap: number;
}

function tailIn(area: HTMLElement | null): Tail | null {
	const holder = area?.querySelector<HTMLElement>("[data-dock-unfold]");
	const row = holder?.parentElement;
	if (!holder || !row) return null;
	const width = (holder.firstElementChild as HTMLElement | null)?.offsetWidth ?? 0;
	return { holder, row, width, gap: Number.parseFloat(getComputedStyle(row).columnGap) || 0 };
}

export function useColumnSlide(
	dock: RefObject<HTMLElement | null>,
	scope: string,
	tab: PaneKind | null,
	folded: boolean,
	/** 展开时两格各在哪：对话和当前标签那一格。 */
	open: { conversation: Box; panel: Box } | null,
	/** 正滑出去、滑完要关掉的最后一个面板。 */
	leaving: PaneKind | null,
): void {
	const collapsed = usePaneDock((s) => s.tabsCollapsed);
	const last = useRef<{ scope: string; tab: PaneKind | null; folded: boolean; collapsed: boolean; leaving: PaneKind | null; tail: Tail | null }>({
		scope,
		tab,
		folded,
		collapsed,
		leaving,
		tail: null,
	});
	const motions = useRef<Animation[]>([]);
	/** 上一段滑的是哪一格。接着画时只有同一格才从它眼下的位置接，换了一格的从起点来。 */
	const slid = useRef<HTMLElement | null>(null);
	/** 标成离开、还没真关的那一个。人在这期间又把它开回来，`leaving` 就被清掉了，这里也就不关。 */
	const pending = useRef<{ scope: string; kind: PaneKind } | null>(null);
	const settle = useRef(() => {
		const left = pending.current;
		pending.current = null;
		if (left && usePaneDock.getState().leaving[left.scope] === left.kind) closeNow(left.scope, left.kind);
	});
	// 这一屏没了，滑到一半的也不能就这么悬着。
	useLayoutEffect(() => () => settle.current(), []);
	useLayoutEffect(() => {
		const previous = last.current;
		// 每一下都量：展开那一下按钮已经卸了，只能用收着时量到的。
		const tail = tailIn(dock.current);
		last.current = { scope, tab, folded, collapsed, leaving, tail };
		const leaves = leaving !== null && leaving !== previous.leaving;
		if (leaves) {
			settle.current();
			pending.current = { scope, kind: leaving };
		}
		// 这一下没滑起来：要关的就现在关。
		const skip = () => {
			if (leaves) settle.current();
		};
		if (previous.scope !== scope) return skip();
		const toggled = previous.folded !== folded && (previous.collapsed !== collapsed || previous.leaving !== leaving);
		const appeared = previous.tab === null && tab !== null && !folded && !document.documentElement.hasAttribute("data-dock-settling");
		if (!toggled && !appeared) return skip();
		const area = dock.current;
		const paneOf = (kind: PaneKind | null) => [...(area?.children ?? [])].find((child): child is HTMLElement => child instanceof HTMLElement && child.dataset.dockPane === kind);
		const conversation = paneOf("conversation");
		const panel = paneOf(tab);
		const room = area?.getBoundingClientRect();
		if (!area || !conversation || !panel || !room?.width || !open || motionReduced()) return skip();

		// 来回连点时从眼下画到的样子接着走，不跳回起点。
		const running = motions.current.some((motion) => motion.playState === "running");
		const same = panel === slid.current;
		const now = running ? { width: conversation.getBoundingClientRect().width, x: same ? new DOMMatrix(getComputedStyle(panel).transform).m41 : null } : null;
		for (const motion of motions.current) motion.cancel();
		slid.current = panel;

		// 面板那一格的宽度：对话让出、面板滑过的都是这一段。
		const shift = room.width * open.panel.width;
		const narrow = room.width * open.conversation.width;
		const start = folded ? { width: narrow, x: 0 } : { width: room.width, x: shift };
		const from = now ? { width: now.width, x: now.x ?? start.x } : start;
		const to = folded ? { width: room.width, x: shift } : { width: narrow, x: 0 };
		// 同一个 id：拖分隔线、改窗口大小时 `freezeMotion` 会把它们直接走完。
		const options = { id: "ly-dock-geometry", duration: DURATION.base, easing: EASE_OUT };
		// 收起后藏着的面板已经被摆成整栏大小了，动画期间按展开时的那一格画。
		const at = folded ? { left: pct(open.panel.left), top: pct(open.panel.top), width: pct(open.panel.width), height: pct(open.panel.height) } : {};
		const widen = conversation.animate([{ width: `${from.width}px` }, { width: `${to.width}px` }], options);
		const slide = panel.animate(
			[
				// 收起那一刻面板已经 `[inert]`、按样式是透明的，这里把它撑住直到滑出去。
				{ ...at, transform: `translateX(${from.x}px)`, opacity: 1 },
				{ ...at, transform: `translateX(${to.x}px)`, opacity: 1 },
			],
			options,
		);
		motions.current = [widen, slide];
		/*
		 * 「展开右栏」那颗按钮收起时一下就挂上了，对话那一格却还窄着，旁边几颗被挤得先往左跳一截，再随
		 * 这一格往右走；展开时它一下就没了，那几颗先往右跳。让它占的那一段（按钮加前面的间距）跟着同一段
		 * 进度长出来、缩回去，那几颗就一路贴着走。进度按对话的宽度折算，来回连点时也从眼下接着走。
		 */
		const progress = (from.width - narrow) / (room.width - narrow || 1);
		if (folded && tail) {
			// 比间距还窄的那一段，用负的左边距把间距也吃掉。
			const taking = (space: number) => ({ width: `${Math.max(0, space - tail.gap)}px`, marginLeft: `${Math.min(0, space - tail.gap)}px`, overflow: "hidden" });
			motions.current.push(tail.holder.animate([taking(progress * (tail.width + tail.gap)), taking(tail.width + tail.gap)], options));
		} else if (!folded && previous.tail) {
			const kept = progress * (previous.tail.width + previous.tail.gap);
			motions.current.push(previous.tail.row.animate([{ marginRight: `${kept}px` }, { marginRight: "0px" }], options));
		}
		const inset = (share: number, sign: number) => `calc(${pct(share)} ${sign > 0 ? "+" : "-"} ${PANE_INSET * Math.abs(sign)}px)`;
		area.style.setProperty("--ly-slide-left", inset(open.panel.left, 1));
		area.style.setProperty("--ly-slide-top", inset(open.panel.top, 1));
		area.style.setProperty("--ly-slide-width", inset(open.panel.width, -2));
		area.style.setProperty("--ly-slide-height", inset(open.panel.height, -2));
		area.dataset.dockSliding = "";
		const left = leaves ? pending.current : null;
		const done = () => {
			// 被下一段接走的不撤：那一段已经重新垫上了，这里的回调晚一个微任务才到。
			if (motions.current[0] === widen) delete area.dataset.dockSliding;
			// 滑完了，或者被下一段接走了：两种都轮到真关。开回来的那种 `leaving` 已经清了，不会关。
			if (left && pending.current === left) settle.current();
		};
		widen.finished.then(done, done);
	}, [dock, scope, tab, folded, collapsed, open, leaving]);
}
