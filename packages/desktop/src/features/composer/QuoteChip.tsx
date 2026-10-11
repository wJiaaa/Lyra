/**
 * 输入框上方那枚「N 条对话引用」，指上去展开引文本身。
 *
 * 引文不放进框里的字：几百字的一段塞进去，框被撑满，要问的那句话被挤到看不见的地方，删也只能一个字
 * 一个字删。收成一枚胶囊，框里只剩人自己要说的话；要核对引了什么，指上去看，不要了在卡片上删。
 */

import { useEffect, useRef, useState } from "react";

import { useI18n } from "../../i18n/index.ts";
import type { DraftQuote } from "../../lib/quote.ts";
import { Quote, Trash2 } from "../../ui/icons/index.ts";
import { Popover } from "../../ui/overlay/Popover.tsx";
import { IconButton } from "../../ui/primitives/IconButton.tsx";

/** 指上去稍等一下再开：从胶囊上划过去打字的那一下不该弹出一张卡。 */
const OPEN_MS = 180;
/** 从胶囊挪到卡片上要跨过中间那几 px 空档，关得太快就够不着卡片上的删除。 */
const CLOSE_MS = 160;

export function QuoteChip({ quotes, onRemove }: { quotes: DraftQuote[]; onRemove: (id: string) => void }) {
	const { t } = useI18n();
	const chip = useRef<HTMLButtonElement>(null);
	const [open, setOpen] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);
	const later = (next: boolean, delay: number) => {
		clearTimeout(timer.current);
		timer.current = setTimeout(() => setOpen(next), delay);
	};
	const keep = () => clearTimeout(timer.current);
	const close = () => {
		clearTimeout(timer.current);
		setOpen(false);
	};

	return (
		<>
			<button
				ref={chip}
				type="button"
				data-ly-quote-chip=""
				aria-expanded={open}
				aria-haspopup="dialog"
				onMouseEnter={() => later(true, OPEN_MS)}
				onMouseLeave={() => later(false, CLOSE_MS)}
				// 键盘和触控板轻点：不等，当场开合。
				onClick={() => {
					clearTimeout(timer.current);
					setOpen((was) => !was);
				}}
				className="flex h-8 w-fit max-w-full items-center gap-1.5 rounded-full bg-card-hover px-3 text-caption text-ink-muted transition-colors hover:text-ink"
			>
				<Quote size={13} strokeWidth={1.9} className="shrink-0" />
				<span className="truncate">{t("composer.quotes", { n: quotes.length })}</span>
			</button>
			{open && (
				<Popover
					anchor={chip.current}
					onClose={close}
					placement="top"
					align="start"
					width="panel"
					surface="panel"
					role="dialog"
					label={t("composer.quotesTitle")}
					maxHeight={360}
					onMouseEnter={keep}
					onMouseLeave={() => later(false, CLOSE_MS)}
				>
					<ul className="flex flex-col gap-1 p-1">
						{quotes.map((quote) => (
							<li key={quote.id} data-ly-quote-card="" className="flex items-start gap-2.5 rounded-lg py-2.5 pr-1.5 pl-3">
								<Quote size={14} strokeWidth={1.9} className="mt-[3px] shrink-0 text-ink-faint" />
								<div className="min-w-0 flex-1">
									<p className="line-clamp-3 text-label break-words whitespace-pre-wrap text-ink">{quote.text}</p>
									<p className="mt-1 text-caption text-ink-faint">{t(quote.from === "user" ? "composer.quoteFromUser" : "composer.quoteFromAssistant")}</p>
								</div>
								<IconButton
									size="sm"
									tone="danger"
									label={t("composer.removeQuote")}
									icon={<Trash2 size={14} />}
									onClick={() => {
										// 删的是最后一条，胶囊跟着没了，卡片不该悬在一个不存在的锚点上。
										if (quotes.length === 1) close();
										onRemove(quote.id);
									}}
								/>
							</li>
						))}
					</ul>
				</Popover>
			)}
		</>
	);
}
