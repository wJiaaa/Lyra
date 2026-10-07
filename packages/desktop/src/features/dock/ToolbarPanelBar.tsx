/**
 * 标签页排法、单屏时，右侧那一栏的标签条和它的按钮画在窗口顶栏里，不在栏里另占一行。
 *
 * 从前是顶栏一行、栏里标签条又一行，两行说的都是这一栏；合成一行，栏里的内容从顶栏下沿就开始。
 * 分屏时每一屏有自己的标题栏，标签条照旧留在栏里——顶栏只有一条，装不下好几栏。
 *
 * 左缘对着这一栏的分隔线，跟着分隔线拖、侧栏开合走：位置量出来直接写到元素上，不走 React，
 * 侧栏滑动的每一帧都要跟一次，每帧渲染一遍不值得。量在 ResizeObserver 里，它在布局之后、绘制之前回调，
 * 画出来的每一帧都贴着分隔线。
 *
 * 开面板的那组按钮（侧边聊天、终端、浏览器、Git）是会话的，留在会话那一侧、停在分隔线左边；
 * 这里只放这一栏自己的：标签、「+」、刷新、弹出、全屏，最右是收起这一栏的开关。七颗挤在窗口角上分不清哪颗管什么。
 *
 * 收起时这一栏不画，标签条也跟着走，只剩那颗开关留在窗口角上——它是展开回来的唯一入口。
 */

import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

/**
 * 栏被全屏、左缘到了对话那一侧时，给顶栏里的会话标题留的宽度：图标、截短的标题和「…」，
 * 再加上它后面那组面板按钮。
 * 平常用不上——对话那一格有自己的最小宽度，栏的左缘不会挤到这里。
 */
const TITLE_ROOM = 160;

/** 分隔线前面留的那一段：会话那组按钮不贴着线。线本身要落在分隔线上，所以栏从线往左再让出这么多。 */
const GUTTER = 6;

export function ToolbarPanelBar({
	slot,
	dock,
	left,
	collapsed,
	children,
}: {
	/** 顶栏里留给这一栏的位置，在会话那组按钮后面，见 `WindowFrame`。 */
	slot: HTMLElement;
	/** 这一屏放面板的那个容器，栏的位置按它算。 */
	dock: RefObject<HTMLDivElement | null>;
	/** 栏在容器里的左缘，占容器宽度的比例。 */
	left: number;
	/** 这一栏收起来了：不跟分隔线，只按内容（那颗开关）的宽度画。 */
	collapsed: boolean;
	children: ReactNode;
}) {
	const bar = useRef<HTMLDivElement>(null);

	useLayoutEffect(() => {
		const element = bar.current;
		const container = dock.current;
		const toolbar = slot.parentElement;
		if (!element || !container || !toolbar) return;
		if (collapsed) {
			element.style.width = "";
			return;
		}
		const title = toolbar.querySelector("[data-ly-toolbar-middle]");
		const end = toolbar.querySelector<HTMLElement>("[data-ly-toolbar-end]");
		const place = () => {
			const box = container.getBoundingClientRect();
			const start = box.left + left * box.width;
			// 不读 slot 自己的右缘：上一次写的宽度过大时它会被挤出去，量到的就不是该停的地方。
			const right = toolbar.getBoundingClientRect().right - Number.parseFloat(getComputedStyle(toolbar).paddingRight);
			const floor = title ? title.getBoundingClientRect().left + TITLE_ROOM + (end?.offsetWidth ?? 0) : start;
			element.style.width = `${Math.max(0, right - Math.max(start - GUTTER, floor))}px`;
		};
		place();
		// 容器的宽度跟着窗口、侧栏变；会话那组按钮会随项目里开得了哪些面板增减，全屏时要给它让位。
		const observer = new ResizeObserver(place);
		for (const each of [container, toolbar, end]) if (each) observer.observe(each);
		return () => observer.disconnect();
	}, [slot, dock, left, collapsed]);

	return createPortal(
		// 收着时只有那颗开关，跟在会话按钮后面隔 2px，和按钮之间的间距一样，不另留边。
		<div ref={bar} data-ly-toolbar-panel className={`flex h-full min-w-0 items-center gap-1.5 ${collapsed ? "pl-0.5" : "pl-1.5"}`}>
			{/* 和会话标题前那一小段同一种线，落在这一栏的分隔线上。 */}
			{!collapsed && <span aria-hidden data-ly-toolbar-divider className="ly-toolbar-divider mr-[3px] h-5 w-px shrink-0" />}
			{children}
		</div>,
		slot,
	);
}
