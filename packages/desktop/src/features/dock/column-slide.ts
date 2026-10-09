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
 */

import { useLayoutEffect, useRef, type RefObject } from "react";
import { holdColumns } from "../../app/hold-column-width.ts";
import { motionReduced } from "../../ui/motion/reduced.ts";
import { DURATION } from "../../ui/motion/tokens.ts";
import { pct } from "./css.ts";
import { usePaneDock } from "./pane-store.ts";
import type { Box } from "./layout.ts";
import type { PaneKind } from "./tree.ts";

/** 侧栏那条：`NavPane` 上的 Tailwind `ease-out`。 */
const EASE_OUT = "cubic-bezier(0, 0, 0.2, 1)";

export function useColumnSlide(
	dock: RefObject<HTMLElement | null>,
	scope: string,
	tab: PaneKind | null,
	folded: boolean,
	/** 展开时两格各在哪：对话和当前标签那一格。 */
	open: { conversation: Box; panel: Box } | null,
): void {
	const collapsed = usePaneDock((s) => s.tabsCollapsed);
	const last = useRef({ scope, folded, collapsed });
	const motions = useRef<Animation[]>([]);
	const hold = useRef<(() => void) | null>(null);
	useLayoutEffect(() => {
		const previous = last.current;
		last.current = { scope, folded, collapsed };
		if (previous.scope !== scope || previous.folded === folded || previous.collapsed === collapsed) return;
		const area = dock.current;
		const paneOf = (kind: PaneKind | null) => [...(area?.children ?? [])].find((child): child is HTMLElement => child instanceof HTMLElement && child.dataset.dockPane === kind);
		const conversation = paneOf("conversation");
		const panel = paneOf(tab);
		const room = area?.getBoundingClientRect();
		if (!conversation || !panel || !room?.width || !open || motionReduced()) return;

		// 来回连点时从眼下画到的样子接着走，不跳回起点。
		const running = motions.current.some((motion) => motion.playState === "running");
		const now = running ? { width: conversation.getBoundingClientRect().width, x: new DOMMatrix(getComputedStyle(panel).transform).m41, opacity: Number(getComputedStyle(panel).opacity) } : null;
		for (const motion of motions.current) motion.cancel();
		// 上一段的释放在 `finished` 之后才轮到，那时会把这一段刚定下的列宽也一起清掉，所以在这里先放。
		hold.current?.();
		hold.current = null;

		// 面板那一格的宽度：对话让出、面板滑过的都是这一段。
		const shift = room.width * open.panel.width;
		const narrow = room.width * open.conversation.width;
		const from = now ?? (folded ? { width: narrow, x: 0, opacity: 1 } : { width: room.width, x: shift, opacity: 0 });
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
		/*
		 * 对话的正文列一开始就排成终点的宽度，滑动期间不逐帧换行——和侧栏开合同一个办法。收起时
		 * 对话变宽，终点那一栏在眼下的格子里放不下，放不下的那截就先伸出去让卡片裁着，卡片右缘
		 * 退到哪露到哪（`wide`）。
		 */
		const release = holdColumns([{ pane: conversation, from: from.width, to: to.width }], { wide: true });
		hold.current = release;
		const done = () => {
			if (hold.current !== release) return;
			release();
			hold.current = null;
		};
		widen.finished.then(done, done);
	}, [dock, scope, tab, folded, collapsed, open]);
}
