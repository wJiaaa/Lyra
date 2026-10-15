/**
 * 一轮对话的过程行：思考、一段工具活、一条命令，共用的那个骨架。
 *
 * 模型先想，然后动手，最后才说话。这三种行是同一件事的三个阶段，读者是连着看的——所以它们必须
 * 长得像同一种东西。在此之前它们是三种：三个行高、三个间距、三种「正在跑」的说法（图标脉动、
 * 文字扫光、图标转圈）。每隔几行就要重新认一次这是什么，那种累不是哪一行不好看造成的，是它们
 * 互相不像造成的。
 *
 * 这个组件只管骨架，不管内容：一个前置图标、一句标题、一个点、一段装不下就化开的摘要、一个可选
 * 的尾部，最右边是展开箭头。展开与否、里面画什么，都还是各自的事。
 *
 * 图标和箭头分居两端，是因为它们说的是两件事：图标说「这一行是什么」，箭头说「点开还是收起」。
 * 它们一度共用最左边那一格（悬停时互换），于是鼠标一放上去，那一行的身份标志就没了。
 *
 * 「正在跑」只有一种说法：摘要上扫过一道光（`ly-glide`，见 glide.css）。不再有第二个转圈的东西
 * 陪着它——同一件事说两遍，就是长任务让人觉得吵的原因。
 */

import { ChevronRight } from "../../ui/icons/index.ts";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { motionReduced } from "../../ui/motion/reduced.ts";

import { ScrollText } from "../../ui/scroll/ScrollText.tsx";

export function FlowRow({
	icon,
	title,
	summary,
	trailing,
	trailFrom,
	running,
	open,
	onToggle,
	label,
	className = "",
	...rest
}: {
	/** 前置图标，常驻。它说的是这一行是什么，不参与展开/收起。 */
	icon: ReactNode;
	/** 这一行是什么。不参与压缩——先被吃掉的永远该是摘要。 */
	title?: ReactNode;
	/** 这一行做了什么。长了两头化开、鼠标放上去自己读出来；运行中它是唯一带动效的东西。 */
	summary?: ReactNode;
	/** 靠右的附注，比如改动行数。 */
	trailing?: ReactNode;
	/** 挂上时附注从这个宽度缓过来，见 `FlowTrail`。 */
	trailFrom?: number;
	running?: boolean;
	/** 省略即为不可展开：不可展开的行不换 chevron，也没有指针手势。 */
	open?: boolean;
	onToggle?: () => void;
	label?: string;
	className?: string;
} & Record<`data-${string}`, string | undefined>) {
	const expandable = onToggle !== undefined;
	const body = (
		<>
			{/* 图标一直在：它说的是这一行是什么（在想 / 在动手 / 在跑命令），不该被别的东西顶掉。 */}
			<span className="ly-flow-lead">{icon}</span>
			{title && <span className="ly-flow-title font-medium text-ink-faint">{title}</span>}
			{title && summary ? <span className="ly-flow-dot" aria-hidden /> : null}
			{/*
			 * 扫光挂在装字的那一层，不挂在外层——这一条是踩出来的。
			 *
			 * `animation` 是一个属性，第二个类不会叠加而是替换，所以扫光和入场淡入不能共用一个 span。
			 * 光交给 `ScrollText` 里装字的那两个 span（它们不随句子重建：句子每多一个从句就换掉正在扫光的
			 * 元素，光会跳回起点）。挂在外层的话，悬停一滚，滚动的那层被单独合成，外层的
			 * `background-clip: text` 裁不到它的字，整句就没了。
			 */}
			{summary !== undefined && summary !== null && summary !== "" && (
				<span className="ly-flow-summary">
					{/*
					 * 这一句和侧边栏的标题是同一种东西：虚化代替省略号，鼠标放上去自己读出来。
					 *
					 * 从前它是 `text-overflow: ellipsis`，于是一行摘要被剁在「…」上——那三个点报告了
					 * 「这里被截了」，却不说截掉的是什么，而想知道的恰恰是那半句。
					 */}
					<ScrollText text={summary} textClassName={running ? "ly-glide" : ""} />
				</span>
			)}
			<FlowTrail from={trailFrom}>{trailing}</FlowTrail>
			{/*
			 * The chevron is back, and it follows the words rather than sitting at the far edge. It was
			 * dropped when the process rows were unified, and a row that opens then looked exactly like
			 * one that does not. A row that navigates elsewhere passes no `open` and draws its own mark.
			 */}
			{expandable && open !== undefined && <ChevronRight size={12} strokeWidth={2} className="ly-flow-chevron" aria-hidden />}
		</>
	);

	/* `ly-scroll` 是摘要悬停自读的那个钩子：动画挂在文字上，触发它的 `:hover` 属于整行。 */
	const shell = `ly-flow-row ly-scroll text-label text-ink-faint transition-colors duration-[var(--ly-t-quick)] hover:text-ink-muted ${className}`;

	if (!expandable) {
		return (
			<div className={shell} role="status" {...rest}>
				{body}
			</div>
		);
	}
	return (
		<button
			type="button"
			onClick={onToggle}
			aria-expanded={open}
			aria-label={label}
			data-expandable=""
			data-open={open ? "" : undefined}
			className={`${shell} w-full cursor-pointer text-left`}
			{...rest}
		>
			{body}
		</button>
	);
}

/**
 * 行尾那一小块（+N -M、秒数、失败记号、子智能体的脸），宽度变的时候缓过去。
 *
 * 它后面还跟着展开箭头。一次改动跑完，「+1 -1」当帧冒出来，箭头一帧里往右跳 44px（量的是真窗口里的
 * `e2e/tool-flow-demo.ts`）；命令跑着时秒数从无到有、从「9s」到「10s」也一样。字在换，行尾在跳。
 *
 * 量的是里面那层的宽度，动的是外面那层：外面那层在过渡，里面那层只在内容变了时才变，观察它就不会把
 * 过渡的每一帧当成又一次变化。`ResizeObserver` 的回调在布局之后、绘制之前，所以新宽度从来不会先画出来
 * 一帧。没有尾巴时外层宽 0、里层不留空，所以它可以一直挂着——从无到有也是缓过去的。
 */
function FlowTrail({ children, from }: { children?: ReactNode; from?: number }) {
	const outer = useRef<HTMLSpanElement>(null);
	const inner = useRef<HTMLSpanElement>(null);
	// 只在挂上时读一次：之后变了也不该重新起步。
	const start = useRef(from);
	useLayoutEffect(() => {
		const box = outer.current;
		const content = inner.current;
		if (!box || !content || typeof ResizeObserver === "undefined") return;
		let last: number | null = null;
		/*
		 * 接替原地另一行时从它的行尾宽度起步（见 `WorkStep`）。在这里就钉上，不等观察者第一次回调：那一次
		 * 回调和这一帧的绘制谁先谁后说不准，晚了就有一帧画的是没钉住的全宽。
		 */
		if (start.current !== undefined && !motionReduced()) {
			last = content.offsetWidth;
			if (last !== start.current) {
				box.style.width = `${start.current}px`;
				void box.offsetWidth;
				box.style.width = `${last}px`;
			}
		}
		const observer = new ResizeObserver(([entry]) => {
			const width = entry.borderBoxSize?.[0]?.inlineSize ?? content.offsetWidth;
			if (last === null || last === width || motionReduced()) {
				last = width;
				return;
			}
			// 上一次还没缓完就又变了：从此刻画着的宽度接着走，不跳回上一个终点。
			const from = box.style.width ? box.getBoundingClientRect().width : last;
			last = width;
			box.style.width = `${from}px`;
			void box.offsetWidth;
			box.style.width = `${width}px`;
		});
		observer.observe(content);
		return () => observer.disconnect();
	}, []);
	const has = children !== undefined && children !== null && children !== false && children !== "";
	return (
		<span
			ref={outer}
			className="ly-flow-trail"
			onTransitionEnd={(event) => {
				if (event.target === event.currentTarget && event.propertyName === "width") event.currentTarget.style.width = "";
			}}
		>
			<span ref={inner} className={has ? "ly-flow-trail-in" : undefined}>
				{has ? children : null}
			</span>
		</span>
	);
}
