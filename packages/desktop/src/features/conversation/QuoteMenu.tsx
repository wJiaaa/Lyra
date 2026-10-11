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
import { CornerDownLeft, MessageCirclePlus } from "../../ui/icons/index.ts";
import { MenuBody, MenuItem } from "../../ui/overlay/Menu.tsx";
import { Popover } from "../../ui/overlay/Popover.tsx";
import { quoteBlock, quotedIn } from "./quote.ts";

const ICON = { size: 14, strokeWidth: 1.8 } as const;

interface Picked {
	text: string;
	range: Range;
	/** 松开鼠标的地方，菜单从这里出来——和右键菜单一样，人的视线在那儿。 */
	point: { x: number; y: number };
	/** 那一刻选区的上沿。滚动时按它挪了多少，把 `point` 跟着挪多少。 */
	top: number;
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
				setPicked(quoted ? { ...quoted, point: { x: event.clientX, y: event.clientY }, top: quoted.range.getBoundingClientRect().top } : null);
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
					const top = was.range.getBoundingClientRect().top;
					return top === was.top ? was : { ...was, point: { x: was.point.x, y: was.point.y + top - was.top }, top };
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

	return (
		<Popover anchor={picked.point} onClose={close} placement="bottom" align="start" width="compact" role="menu">
			<MenuBody>
				{/*
				 * 按下去不能动选区：一动，`selectionchange` 先把菜单收了，点击就落了空。
				 * 行本身照常处理点击，点完就收。
				 */}
				<div onMouseDown={(event) => event.preventDefault()} onClick={close}>
					<MenuItem icon={<MessageCirclePlus {...ICON} />} onClick={askAside}>
						{t("conversation.quoteAskSide")}
					</MenuItem>
					<MenuItem icon={<CornerDownLeft {...ICON} />} onClick={toComposer}>
						{t("conversation.quoteToComposer")}
					</MenuItem>
				</div>
			</MenuBody>
		</Popover>
	);
}
