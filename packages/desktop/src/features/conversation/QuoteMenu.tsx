/**
 * 在对话里划一段字，拿去侧边聊天问，或者引用到下面的输入框里接着说。
 *
 * 两样都只是把引文放进输入框、光标停在后面，不替人发出去：划下来的是材料，问什么还得人自己说。
 * 字在松开鼠标那一刻就取好了——正在写的那条回复下一帧可能又长了一截，点下去时再读选区，拿到的会是
 * 另一段。
 */

import { useEffect, useState, type RefObject } from "react";
import { useScopedSessionId } from "../../app/session-scope.tsx";
import { quoteInSideChat } from "../../app/side-quote.ts";
import { useI18n } from "../../i18n/index.ts";
import { useApp } from "../../store/index.ts";
import { Popover } from "../../ui/overlay/Popover.tsx";
import { quoteBlock, quotedIn } from "./quote.ts";

/*
 * 一段：内衬由这里定，宽度由这一段的字定。
 *
 * 两段并排、中间一条通到上下沿的线：划完字，人的注意力就在那一小片选区上，两样动作该一眼看完，
 * 而不是列成一列让人往下读。
 *
 * 字号取比界面字号小一号的 `caption`，不是菜单行的 `label`：这一条只有三十来像素高，贴着正文，
 * 用菜单行的字号就成了压在上面的一块面板。
 */
const SEGMENT = "min-w-0 px-2.5 py-1.5 hover:bg-card-hover";

interface Picked {
	text: string;
	range: Range;
	/**
	 * 菜单挂在选区上，不挂鼠标：`x` 是选区的横中线，`y` 是它的上沿。
	 *
	 * 上面放不下时 `Popover` 会自己翻到下面去（`placement="top"`），滚动时按选区挪了多少，把这个点
	 * 跟着挪多少。挂鼠标那一点的话，同一次划选从左往右划和从右往左划，菜单会落在两个地方。
	 */
	at: { x: number; y: number };
}

/** 菜单压在选区上：横向对它的中线，上沿是它的上沿。 */
function atOf(range: Range): Picked["at"] {
	const rect = range.getBoundingClientRect();
	return { x: rect.left + rect.width / 2, y: rect.top };
}

export function QuoteMenu({ scrollRef }: { scrollRef: RefObject<HTMLDivElement | null> }) {
	const { t } = useI18n();
	const sessionId = useScopedSessionId();
	const [picked, setPicked] = useState<Picked | null>(null);

	useEffect(() => {
		const box = scrollRef.current;
		if (!box) return;
		const onUp = (event: MouseEvent) => {
			if (event.button !== 0) return;
			// 双击、三击选词选段，选区要等这一下松开之后才定。
			requestAnimationFrame(() => {
				const quoted = quotedIn(window.getSelection(), box);
				setPicked(quoted ? { ...quoted, at: atOf(quoted.range) } : null);
			});
		};
		/*
		 * 跟着字走，不是滚一下就收。贴着底部时回复每长一截转录就滚一次，滚就收的话，菜单在正在写的
		 * 那条回复上一出来就没了。
		 */
		let frame = 0;
		const onScroll = () => {
			if (frame) return;
			frame = requestAnimationFrame(() => {
				frame = 0;
				setPicked((was) => {
					if (!was) return was;
					const now = atOf(was.range);
					return now.x === was.at.x && now.y === was.at.y ? was : { ...was, at: now };
				});
			});
		};
		box.addEventListener("mouseup", onUp);
		box.addEventListener("scroll", onScroll, { passive: true });
		return () => {
			cancelAnimationFrame(frame);
			box.removeEventListener("mouseup", onUp);
			box.removeEventListener("scroll", onScroll);
		};
	}, [scrollRef]);

	// 选区没了（按了方向键、点了别处的字），菜单跟着走。
	useEffect(() => {
		if (!picked) return;
		const onChange = () => {
			if (window.getSelection()?.isCollapsed !== false) setPicked(null);
		};
		document.addEventListener("selectionchange", onChange);
		return () => document.removeEventListener("selectionchange", onChange);
	}, [picked]);

	if (!picked || !sessionId) return null;

	const close = () => setPicked(null);
	const quote = quoteBlock(picked.text);

	const askAside = () => quoteInSideChat(sessionId, quote);
	const toComposer = () => useApp.getState().setComposerDraft(quote, { sessionId });

	/*
	 * 挂点是选区（见 `Picked.at`），`top` + `center`：压在选区上方、横向居中，上面不够高 `Popover`
	 * 自己会翻到下面。
	 *
	 * `hug` + `w-max`：宽度跟着两段的字走。写死的宽度在中文和英文的标签之间总有一边要截断，而这条
	 * 菜单的两段本来就该各按自己的字数排开。`w-max` 挡住窗口太窄时收缩成多行——`maxWidth` 兜底。
	 * `panel`：整张卡都是内容，不留菜单那圈 4px 内衬，中间那条线才通到上下沿。
	 */
	return (
		<Popover
			anchor={picked.at}
			onClose={close}
			placement="top"
			align="center"
			width="hug"
			surface="panel"
			className="w-max"
			role="menu"
		>
			{/*
			 * 按下去不能动选区：一动，`selectionchange` 先把菜单收了，点击就落了空。
			 * 两段本身照常处理点击，点完就收。
			 */}
			<div
				className="flex text-caption text-ink"
				onMouseDown={(event) => event.preventDefault()}
				onClick={close}
			>
				<button type="button" role="menuitem" className={SEGMENT} onClick={askAside}>
					{t("conversation.quoteAskSide")}
				</button>
				{/* 撑满整条的一个元素，不是左边那段的右边框：hover 的底色不该盖到线上。 */}
				<div className="w-px shrink-0 bg-line-float" aria-hidden />
				<button type="button" role="menuitem" className={SEGMENT} onClick={toComposer}>
					{t("conversation.quoteToComposer")}
				</button>
			</div>
		</Popover>
	);
}
