/**
 * What a conversation row cannot say in one line, on hover.
 *
 * The row is a title and nothing else — deliberately, because in a pane 240px wide a second column
 * of names competes with the titles for the space the titles need. Everything that used to be
 * fighting for that space, and several things that were never shown at all, live here instead.
 *
 * A card rather than a tooltip. The app's tips are one string on an inverted surface, which is
 * right for 「关闭」 and wrong for four labelled figures — those want alignment, marks, and room to
 * separate the identity of the thing from the numbers about it.
 *
 * That separation is spacing alone. It was two hairlines, which at this size read as a table drawn
 * inside something the width of a business card: three rules counting the border, on 248px, around
 * two short lines and three figures. The gaps were already doing the work.
 *
 * Portalled to `<body>`: the sidebar is a scroller that clips its overflow, and a card pinned
 * beside a row would be cut off at the pane's edge — which is exactly where it needs to be.
 */

import { translate } from "../../i18n/translate.ts";
import { ArrowDownToLine, ArrowUpFromLine, Bot, FolderOpen, MessageCircle, MessageSquare, MessagesSquare } from "../../ui/icons/index.ts";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { SessionMeta, Usage } from "@plume/core";
import { freshTokens } from "@plume/core/tokens";
import { formatTokens } from "../conversation/index.ts";
import { formatCost } from "../settings/index.ts";
import { hoverLayersSuppressed, onHoverLayersDismissed } from "../../ui/overlay/hover-layers.ts";
import { chromeTop } from "../../ui/overlay/chrome-top.ts";
import { portal } from "../../ui/overlay/portal.ts";
import { baseName } from "../../lib/paths.ts";
import { hourStyle } from "../../lib/hour-style.ts";
import { useI18n, type ResolvedUiLocale } from "../../i18n/index.ts";
import { sessionHome } from "../../lib/session-home.ts";

/**
 * How long the pointer has to rest before this appears.
 *
 * Long enough that running the pointer down the list to reach something does not strobe a card at
 * every row on the way, short enough that stopping on a row and waiting does not feel like waiting.
 */
const OPEN_DELAY_MS = 420;
/** Matches `.ly-card-out`; the card is unmounted once it has played. */
const LEAVE_MS = 110;
/** Distance from the row, matching the gap the app's tooltips keep. */
const GAP = 8;
/**
 * Over the window's own layers (up to 120), under the tooltips (220).
 *
 * It was above them, on the grounds that this is the thing the pointer is deliberately holding —
 * which is true of the card and false of the comparison. Resting on the archive icon summons both,
 * and the bubble under that icon overhangs the pane by a few pixels, so 「归档会话」 was sliding
 * under this card's left edge with no way to read it. The label for the button directly beneath the
 * pointer is the more specific of the two, and it is also the smaller — it costs 8px of a card that
 * is 248 wide.
 *
 * Menus (60) and dialogs (80+) are *below* this number and stay legible anyway, because this card
 * gets out of their way rather than trying to out-rank them: a menu holds it back for as long as it
 * is open, and a dialog's scrim leaves no row to hover in the first place. See `useSessionCard`.
 */
const CARD_Z = 210;

/** `2026-08-26 17:50`, or a relative day count for anything recent — whichever reads faster. */
function when(at: number, locale: ResolvedUiLocale): string {
	const days = Math.floor((Date.now() - at) / 86_400_000);
	if (days === 0) {
		return new Date(at).toLocaleTimeString(locale, { hour: hourStyle(locale), minute: "2-digit" });
	}
	if (days === 1) return translate("sessionCard.yesterday");
	if (days < 30) return translate("sessionCard.daysAgo", { n: days });
	return new Date(at).toLocaleDateString(locale, { month: "numeric", day: "numeric" });
}

/**
 * How much of the input never had to be re-read.
 *
 * Against everything that was sent, not against the total: output tokens are generated rather than
 * read, so counting them in the denominator makes a well-cached session look worse the more it
 * says back. Null when nothing has been sent at all, which is not a 0% hit rate — it is no data.
 *
 * Cache writes belong in the denominator. They are input that was sent and paid for at full rate;
 * leaving them out inflates the rate on exactly the providers that report them — an Anthropic turn
 * that wrote 5k to the cache and read 20k from it is a 80% hit, not the 99% it used to read as.
 *
 * Over the conversation's own replies (`replyUsage`), the way ZCode and deepseek-harness count it.
 * Sub-agents, titles and compaction each start a prefix of their own; mixed in, they pulled the
 * rate down and could hide a main loop whose cache had stopped working. `usage` only for a row
 * that has not been counted yet.
 */
function cacheHitRate(session: SessionMeta): number | null {
	const usage = session.replyUsage ?? session.usage;
	const sent = usage.input + usage.cacheRead + usage.cacheWrite;
	if (sent <= 0) return null;
	return usage.cacheRead / sent;
}

/** 卡片要的那几个数；`addUsage` 在 core 根入口上，渲染进程拿不到它的值。 */
type Spent = Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite"> & { cost: Pick<Usage["cost"], "total"> };

function plus(a: Spent, b: Spent): Spent {
	return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite, cost: { total: a.cost.total + b.cost.total } };
}

/**
 * 花在哪段对话上：主会话自己（连标题、压缩这些附带调用）、侧边聊天、子智能体，三格加起来是总 token。
 *
 * 侧边聊天自己派出去的子智能体算在侧边聊天里——按「花在哪段对话上」分，不按「谁干的活」分。
 */
function sources(session: SessionMeta): { main: number; side: number; subagents: number } {
	const subagents = session.subagentUsage ? freshTokens(session.subagentUsage) : 0;
	return {
		main: Math.max(0, freshTokens(session.usage) - subagents),
		side: session.sideUsage ? freshTokens(session.sideUsage) : 0,
		subagents,
	};
}

/**
 * 一个总数：主会话、子智能体、侧边聊天都在里面，各自的钱在它们自己出现的地方。
 *
 * 价格是请求当时按单价记下的。花了 token 却是 0 美元，是模型没定价，不是免费——写「未定价」，
 * 不写 $0.00；什么都没发过的会话是一道横线。
 */
function costText(spent: Spent): { text: string; priced: boolean } {
	const cost = formatCost(spent.cost.total);
	if (cost) return { text: cost, priced: true };
	return { text: freshTokens(spent) > 0 ? translate("sessionCard.unpriced") : "–", priced: false };
}

/** 今天的只写钟点，别的日子带上月日：开始时间要的是「哪一天」，相对天数在右上角已经有了。 */
function startedAt(at: number, locale: ResolvedUiLocale): string {
	const time = new Date(at).toLocaleTimeString(locale, { hour: hourStyle(locale), minute: "2-digit" });
	if (new Date(at).toDateString() === new Date().toDateString()) return time;
	return `${new Date(at).toLocaleDateString(locale, { month: "numeric", day: "numeric" })} ${time}`;
}

const tokensOrDash = (n: number) => (n > 0 ? formatTokens(n) : "–");

/** 「3 轮 · 41 步」；没数过步数的旧会话只有轮数，两样都没有是一道横线。 */
function turnsText(session: SessionMeta): string {
	if (session.turns === undefined) return "–";
	if (session.steps === undefined) return String(session.turns);
	return translate("sessionCard.turnsSteps", { turns: session.turns, n: session.steps });
}

/** Whole percent, except that something short of 100% never reads as 100%: 99.96% shows 99.9%. */
function percent(rate: number): string {
	const whole = Math.round(rate * 100);
	return whole === 100 && rate < 1 ? `${(Math.floor(rate * 1000) / 10).toFixed(1)}%` : `${whole}%`;
}

/**
 * The directory's own name, not the road to it.
 *
 * `~/Downloads/源码-plfx` says the same thing as `源码-plfx` plus three segments nobody is reading
 * — and the row above already carried the project, which for a checkout is that same word again.
 * One name, once.
 */
function folderName(path: string): string {
	// Either separator, or a Windows cwd is shown whole. The root has no last segment; it names itself.
	return baseName(path) || path;
}

/**
 * One figure with a word for what it is.
 *
 * The number alone was ambiguous — 97 and 57% and 1.0k in a row read as three unrelated readings,
 * and the marks are too small to carry the meaning on their own. The label goes above rather than
 * beside so three of them tile evenly however wide the values run.
 */
function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
	return (
		/*
		 * Each column is as wide as its own contents, with the figure centred under its word.
		 *
		 * Two things have to hold at once, and the obvious shapes each break one. Equal thirds with
		 * everything centred keeps the pairs together but leaves a visible margin at both edges that
		 * the title and folder lines above do not have, so the row reads as inset from the rest of
		 * the card. Equal thirds with the ends pushed outwards fixes the edges and breaks the pairs:
		 * the label is centred in its third while the number is flush to the card, and 「消息」 ends
		 * up sitting to the right of its own count.
		 *
		 * Sizing each column to its contents and spacing them apart satisfies both. Nothing is
		 * centred *within* a wider box, so a label and its value share a centre line; the first
		 * column's left edge and the last column's right edge are the row's own, which is the
		 * padding — the same left and right edges as everything above.
		 */
		<div className="flex min-w-0 flex-col items-center gap-0.5">
			<span className="flex items-center gap-1 text-caption text-ink-faint">
				<span className="shrink-0">{icon}</span>
				{label}
			</span>
			<span className="max-w-full truncate text-detail text-ink tabular-nums">{value}</span>
		</div>
	);
}

function Row({ icon, children, mono }: { icon: React.ReactNode; children: React.ReactNode; mono?: boolean }) {
	return (
		<div className="flex items-center gap-1.5 text-detail text-ink-muted">
			<span className="shrink-0 text-ink-faint">{icon}</span>
			<span className={`min-w-0 truncate ${mono ? "font-mono" : ""}`}>{children}</span>
		</div>
	);
}

export function SessionCard({
	session,
	anchor,
	project,
	leaving,
}: {
	session: SessionMeta;
	/** The row's rectangle, in viewport coordinates. */
	anchor: DOMRect;
	/** Shown only where the list is not already grouped by project. */
	project?: string;
	/** Playing its exit; see `useSessionCard`. */
	leaving?: boolean;
}) {
	const { resolvedLocale } = useI18n();
	const card = useRef<HTMLDivElement>(null);
	const [at, setAt] = useState<{ left: number; top: number } | null>(null);

	/*
	 * Placed after measuring, in a layout effect, so it is never painted at the wrong spot first.
	 *
	 * To the right of the row where there is room, and flipped to the left where there is not —
	 * the sidebar can be dragged wide enough that its right edge is most of the way across the
	 * window. Vertically it is clamped rather than flipped: a card that jumped above the pointer
	 * near the foot of a list would be harder to follow than one that simply stops travelling.
	 */
	useLayoutEffect(() => {
		const box = card.current?.getBoundingClientRect();
		if (!box) return;
		const right = anchor.right + GAP;
		const left = right + box.width > window.innerWidth - GAP ? anchor.left - GAP - box.width : right;
		// Kept under the window's toolbar as well as off the bottom edge: a tall card for a low row was pushed up over it.
		const top = Math.max(chromeTop() + GAP, Math.min(Math.max(GAP, anchor.top - 6), window.innerHeight - box.height - GAP));
		setAt({ left: Math.max(GAP, left), top });
	}, [anchor]);

	// 侧边聊天是自己的会话，花的不在 `usage` 里；总数连它们一起算才名副其实。
	const spent: Spent = session.sideUsage ? plus(session.usage, session.sideUsage) : session.usage;
	const cost = costText(spent);
	const hit = cacheHitRate(session);
	const from = sources(session);

	return portal(<div
			ref={card}
			role="tooltip"
			data-ly-session-card=""
			style={{ zIndex: CARD_Z, left: at?.left ?? -9999, top: at?.top ?? -9999, opacity: at ? undefined : 0 }}
			className={`ly-glass-solid pointer-events-none fixed w-[248px] overflow-hidden rounded-xl border border-line-soft ${
				leaving ? "ly-card-out" : "ly-card-in"
			}`}
		>
			<div className="flex items-start gap-2 px-3 pt-2.5 pb-2">
				{/* Three lines at most: a title derived from a long first message can be a paragraph. */}
				<p className="line-clamp-3 min-w-0 flex-1 text-label leading-[18px] text-ink">{session.title}</p>
				<span className="mt-[1px] shrink-0 text-caption text-ink-faint tabular-nums">{when(session.updatedAt, resolvedLocale)}</span>
			</div>

			{/*
			 * One line, and a folder mark on it.
			 *
			 * There were two: the project, and the full path. For a checkout those are the same word
			 * twice over — 「源码-plfx」 above 「~/Downloads/源码-plfx」 — and the mark on the first was
			 * a branch, which this has no way of knowing: `SessionMeta` records where a conversation
			 * ran, not what was checked out at the time. A stale branch name would be worse than none.
			 */}
			<div className="px-3 py-2">
				<Row icon={<FolderOpen size={11.5} strokeWidth={1.9} />}>{project ?? folderName(sessionHome(session))}</Row>
			</div>

			{/*
			 * 钱先说，单独放大：「这段对话花了多少」是这张卡最常被问的一句。它右边的小字是 token 总数和
			 * 命中率——命中率只算主对话（见 `cacheHitRate`），所以标签上写明是主会话的，免得被读成
			 * 旁边那个总数的命中率。
			 *
			 * 「token」是 fresh tokens，不是 `usage.total`：total 把每次读缓存又算一遍，一段长会话会在
			 * 95% 命中旁边报出五亿 token。读缓存放在最底下那行小字里，不和它们并列。
			 */}
			<div className="flex items-baseline justify-between gap-2 px-3 pt-1.5 pb-0.5">
				<span data-ly-session-cost="" className={cost.priced ? "text-heading font-semibold text-ink tabular-nums" : "text-body text-ink-faint"}>{cost.text}</span>
				<span className="text-right text-caption leading-[15px] text-ink-faint">
					<span className="font-medium text-ink-muted tabular-nums">{formatTokens(freshTokens(spent))}</span> {translate("sessionCard.tokens")}
					<br />
					{translate("sessionCard.mainCache")} <span className="font-medium text-ink-muted tabular-nums">{hit === null ? "–" : percent(hit)}</span>
				</span>
			</div>

			{/*
			 * 两行共用三列：上面是这段对话有多长、进出多少，下面是 token 花在哪段对话上，三格加起来就是
			 * 上面那个总数。没开过侧边聊天、没派过子智能体，那一格是横线不是 0，一眼看出「这次没有」。
			 *
			 * 每一格都画，没话可说就是横线，否则缺一格后面的会挪出它们的列。轮次而不是 `messageCount`：
			 * 后者连每个工具结果都算，一轮跑四十个工具读出来是八十多。
			 */}
			<div data-ly-session-figures="" className="grid grid-cols-[repeat(3,auto)] justify-between gap-x-2 gap-y-2 px-3 py-2">
				<Stat icon={<MessagesSquare size={11} strokeWidth={2} />} label={translate("sessionCard.turns")} value={turnsText(session)} />
				<Stat icon={<ArrowDownToLine size={11} strokeWidth={2} />} label={translate("sessionCard.input")} value={formatTokens(spent.input + spent.cacheWrite)} />
				<Stat icon={<ArrowUpFromLine size={11} strokeWidth={2} />} label={translate("sessionCard.output")} value={formatTokens(spent.output)} />
				<Stat icon={<MessageSquare size={11} strokeWidth={2} />} label={translate("sessionCard.partMain")} value={tokensOrDash(from.main)} />
				<Stat icon={<MessageCircle size={11} strokeWidth={2} />} label={translate("sessionCard.partSide")} value={tokensOrDash(from.side)} />
				<Stat icon={<Bot size={11} strokeWidth={2} />} label={translate("sessionCard.partSubagents")} value={tokensOrDash(from.subagents)} />
			</div>

			<p data-ly-session-foot="" className="truncate px-3 pb-2.5 text-caption text-ink-faint tabular-nums">
				{translate("sessionCard.started", { at: startedAt(session.createdAt, resolvedLocale) })} · {translate("sessionCard.readCache", { n: formatTokens(spent.cacheRead) })}
			</p>
		</div>);
}

/**
 * Hover state for one row, with the delay and the teardown that go with it.
 *
 * Returned as props rather than rendered here, so the row keeps ownership of its own markup — and
 * so a row that unmounts mid-hover (the list re-sorts constantly) takes its timer with it.
 *
 * `onOpen` fires when the wait is up and the card is about to be shown — the one moment the figures
 * on it are being read, and so the one moment worth going to disk for them. Not on the mouse
 * entering: running the pointer down forty rows to reach one would be forty reads of the index for
 * forty cards nobody asked to see.
 */
export function useSessionCard(onOpen?: () => void): {
	anchor: DOMRect | null;
	leaving: boolean;
	bind: {
		onMouseEnter: (event: React.MouseEvent<HTMLElement>) => void;
		onMouseLeave: () => void;
		onClick: () => void;
	};
	dismiss: () => void;
} {
	const [anchor, setAnchor] = useState<DOMRect | null>(null);
	/*
	 * Held on screen for the length of the exit animation.
	 *
	 * Dropping the anchor the moment the pointer leaves unmounts the card, and a card React has
	 * already removed cannot animate — it simply blinks out, which beside a 130ms entrance reads as
	 * a glitch rather than as a dismissal. Marking it first and removing it after is what gives the
	 * animation something to play on; same arrangement as the toast stack.
	 */
	const [leaving, setLeaving] = useState(false);
	const open = useRef<number | undefined>(undefined);
	const close = useRef<number | undefined>(undefined);

	const dismiss = useCallback(() => {
		window.clearTimeout(open.current);
		window.clearTimeout(close.current);
		setAnchor(null);
		setLeaving(false);
	}, []);

	useEffect(() => {
		const hide = () => dismiss();
		window.addEventListener("scroll", hide, true);
		window.addEventListener("wheel", hide, true);
		window.addEventListener("blur", hide);
		/*
		 * A menu or a dialog opening takes this away — see `hover-layers`.
		 *
		 * Not the same thing as the `dismiss()` in the row's `onContextMenu`. That one is about
		 * *this* row's card at the moment of the press, and it covered the first frame and nothing
		 * after it: the pointer wanders off, comes back to a row, and 420ms later a 248px card is
		 * drawn over the menu that is still open — at 210 against the menu's 60, so it wins outright
		 * and hides what it covers. This is about every row's card, and about the dialog that menu
		 * goes on to raise.
		 */
		const unsubscribe = onHoverLayersDismissed(dismiss);
		return () => {
			window.clearTimeout(open.current);
			window.clearTimeout(close.current);
			window.removeEventListener("scroll", hide, true);
			window.removeEventListener("wheel", hide, true);
			window.removeEventListener("blur", hide);
			unsubscribe();
		};
	}, [dismiss]);

	return {
		anchor,
		leaving,
		dismiss,
		bind: {
			onMouseEnter: (event) => {
				if (hoverLayersSuppressed()) return;
				const box = event.currentTarget.getBoundingClientRect();
				window.clearTimeout(open.current);
				window.clearTimeout(close.current);
				// Coming back before the exit finished is a re-entry, not a second arrival.
				setLeaving(false);
				open.current = window.setTimeout(() => {
					// Asked again on arrival: a menu can open during the wait without the pointer moving.
					if (hoverLayersSuppressed()) return;
					onOpen?.();
					setAnchor(box);
				}, OPEN_DELAY_MS);
			},
			onMouseLeave: () => {
				window.clearTimeout(open.current);
				setLeaving(true);
				close.current = window.setTimeout(() => {
					setAnchor(null);
					setLeaving(false);
				}, LEAVE_MS);
			},
			onClick: () => {
				dismiss();
			},
		},
	};
}
