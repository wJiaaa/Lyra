/**
 * 右栏收起、展开，照左边侧栏开合的样子动：面板保持自己的宽度从右边滑进、淡入，对话那一格跟着
 * 让出（收起时跟着补上）同样的宽度，两边同一条曲线、同一段时长，接缝始终贴在一起。侧栏是
 * `NavPane` 的 margin 过渡加 `holdColumnWidth`，这里是同一件事的镜像。
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
import { EASE_OUT, holdColumns } from "../../app/hold-column-width.ts";
import { motionReduced } from "../../ui/motion/reduced.ts";
import { DURATION } from "../../ui/motion/tokens.ts";
import { pct } from "./css.ts";
import { closeNow, usePaneDock } from "./pane-store.ts";
import type { Box } from "./layout.ts";
import type { PaneKind } from "./tree.ts";

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
	const last = useRef({ scope, tab, folded, collapsed, leaving });
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
		last.current = { scope, tab, folded, collapsed, leaving };
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
		if (!conversation || !panel || !room?.width || !open || motionReduced()) return skip();

		// 来回连点时从眼下画到的样子接着走，不跳回起点。
		const running = motions.current.some((motion) => motion.playState === "running");
		const same = panel === slid.current;
		const now = running ? { width: conversation.getBoundingClientRect().width, x: same ? new DOMMatrix(getComputedStyle(panel).transform).m41 : null, opacity: same ? Number(getComputedStyle(panel).opacity) : null } : null;
		for (const motion of motions.current) motion.cancel();
		slid.current = panel;

		// 面板那一格的宽度：对话让出、面板滑过的都是这一段。
		const shift = room.width * open.panel.width;
		const narrow = room.width * open.conversation.width;
		const start = folded ? { width: narrow, x: 0, opacity: 1 } : { width: room.width, x: shift, opacity: 0 };
		const from = now ? { width: now.width, x: now.x ?? start.x, opacity: now.opacity ?? start.opacity } : start;
		const to = folded ? { width: room.width, x: shift, opacity: 0 } : { width: narrow, x: 0, opacity: 1 };
		// 同一个 id：拖分隔线、改窗口大小时 `freezeMotion` 会把它们直接走完。
		const options = { id: "ly-dock-geometry", duration: DURATION.base, easing: EASE_OUT };
		// 收起后藏着的面板已经被摆成整栏大小了，动画期间按展开时的那一格画。
		const at = folded ? { left: pct(open.panel.left), top: pct(open.panel.top), width: pct(open.panel.width), height: pct(open.panel.height) } : {};
		const widen = conversation.animate([{ width: `${from.width}px` }, { width: `${to.width}px` }], options);
		const slide = panel.animate(
			[
				{ ...at, transform: `translateX(${from.x}px)`, opacity: from.opacity },
				{ ...at, transform: `translateX(${to.x}px)`, opacity: to.opacity },
			],
			options,
		);
		motions.current = [widen, slide];
		// 对话的正文从眼下的宽度和位置一路走到终点，左右两条边都只朝一个方向——和侧栏开合同一个办法。
		holdColumns(conversation, widen);
		const left = leaves ? pending.current : null;
		const done = () => {
			// 滑完了，或者被下一段接走了：两种都轮到真关。开回来的那种 `leaving` 已经清了，不会关。
			if (left && pending.current === left) settle.current();
		};
		widen.finished.then(done, done);
	}, [dock, scope, tab, folded, collapsed, open, leaving]);
}
