import { Collapse } from "../../ui/layout/Collapse.tsx";
import { translate } from "../../i18n/translate.ts";
import { Brain } from "../../ui/icons/index.ts";
import { useLayoutEffect, useMemo, useRef, useState } from "react";

import { FlowRow } from "./FlowRow.tsx";
import { Markdown } from "./Markdown.tsx";
import { thinkingTail } from "./thinking-ticker.ts";
import { Scroller } from "../../ui/scroll/Scroller.tsx";
import { useTranscriptDisclosure } from "./view-state.ts";

/**
 * 模型的推理，收在一条流水行里。
 *
 * 和它下面那段工具活、那条命令是同一个骨架（见 `FlowRow`）：同样的 16px 图标槽、同样的行高。
 *
 * 行上只写标题，不写推理本身。它曾经把推理一句一句打在行上、写完停在第一句：一段几分钟的推理在那一行
 * 上滚个不停，是整屏最吵的东西，而那一句半截话几乎从来不是读者要的——要看推理的人会点开。
 * 运行中是一个说「在想」的词，加上标题上扫过的那道光（和别的过程行一样）；写完是「思考了 N 秒」，一个
 * 不会动的数，却说得出这段推理有多长。点开是全文。
 *
 * 运行中不走秒：下面那行运行指示已经有一个在走的钟，两个钟挨着跳是同一件事说两遍，差一秒时还像算错了。
 */
export function ThinkingBlock({
	text,
	redacted,
	live,
	startedAt,
	durationMs,
	stateKey,
}: {
	text: string;
	redacted: boolean;
	/** 字还在到：后面还没有别的块。 */
	live?: boolean;
	/** 这段推理开始的时刻（`ThinkingContent.startedAt`），运行中拿它选那个词。 */
	startedAt?: number;
	/** 这段推理想了多久（`ThinkingContent.durationMs`）。旧会话、中途断掉的推理没有。 */
	durationMs?: number;
	stateKey?: string;
}) {
	const [open, setOpen] = useTranscriptDisclosure(stateKey);

	if (!text && !redacted) return null;

	return (
		<div data-ly-thinking="">
			<FlowRow
				icon={<Brain size={13} strokeWidth={1.8} />}
				summary={redacted ? translate("thinking.redacted") : live ? translate(liveWord(startedAt)) : thoughtFor(durationMs)}
				running={live === true}
				open={open}
				{...(redacted ? {} : { onToggle: () => { setOpen((v) => !v); } })}
				label={translate("thinking.process")}
			/>
			{/*
			 * 收起后不留子树：留着的话，隐藏的正文照样随每个 token 重排，展开过一次的思考在收起之后
			 * 仍把流式中的窗口拖在 20 帧上下。重新展开只是再解析一遍，17 万字也不到一毫秒。
			 */}
			<Collapse open={open && !redacted} bodyClassName="mt-1.5 border-l-2 border-line pl-3"><ThinkingBody text={text} live={live === true} /></Collapse>
		</div>
	);
}

/** 运行中可以说的那几个词。 */
const LIVE_WORDS = ["thinking.live", "thinking.live2", "thinking.live3", "thinking.live4", "thinking.live5", "thinking.live6"] as const;

/**
 * 这一段推理用哪个词。
 *
 * 一段一个，从开始写到写完不换：中途轮换的话，这一行每隔几秒变一次，又回到了它曾经那种不停换字的吵。
 * 按开始时刻选而不是随机，重绘、切会话回来重新挂载都还是同一个词。不知道开始时刻时用第一个。
 */
function liveWord(startedAt: number | undefined): (typeof LIVE_WORDS)[number] {
	return LIVE_WORDS[startedAt === undefined ? 0 : Math.floor(startedAt) % LIVE_WORDS.length];
}

/**
 * 写完之后的「思考了 N 秒」。
 *
 * 秒向下取整，和它下面那行运行指示（`RunningIndicator` 的 `formatElapsed`）同一种取法——向上取整的话，
 * 推理明明比这一轮开始得晚，思考行却可能比运行指示多一秒。
 *
 * 不满一秒的不报数，和说不出时长的一样写「思考了一会儿」（与整轮摘要里只有思考的那一句
 * `turnProcess.thoughtOnly` 同一种说法）。真正一秒不到的推理很少；常见的是中转把整段推理一次吐出来，
 * 开始和结束几乎同时到，量到的几毫秒不是它想了多久——报一个「1 秒」是一个看着很真的错数。
 */
function thoughtFor(durationMs: number | undefined): string {
	if (durationMs === undefined || durationMs < 1000) return translate("thinking.forAWhile");
	const seconds = Math.floor(durationMs / 1000);
	if (seconds < 60) return translate("thinking.forSeconds", { n: seconds });
	return translate("thinking.forMinutes", { m: Math.floor(seconds / 60), s: seconds % 60 });
}

/**
 * 点开之后的全文，装在一个限高、自己滚动的框里。
 *
 * 还在写的时候只放纯文本的尾巴（见 `thinkingTail`）。整段 Markdown 逐字淡入地跟着流写，每个
 * token 都要把越来越长的全文重排一遍：实测一段 17 万字的推理展开着写，主线程五秒里占满四秒半，
 * 窗口只剩四五帧，耗时几乎全在浏览器的样式与布局，不在解析。写完再换成 Markdown，那一次很便宜。
 *
 * 限高对写完的也成立：一段几十屏的推理整个摊开，会把真正的回复推到很远的地方去。
 *
 * 跟着底部走，用户往上翻了就不跟；从历史里点开的从头读，所以初值取 `live`。
 *
 * 往上翻的时候窗口的起点也停住（`held`）。不停的话尾巴每前进一步就从顶上切掉几千字，正在读的那段
 * 被抽走，滚动位置被夹回底部，跟随又自己接上了——按每秒两千字算，每两秒一次，往上根本翻不动。
 * 停住期间框里的纯文本会长过 `LIVE_TAIL`，回到底部就收回去。
 */
function ThinkingBody({ text, live }: { text: string; live: boolean }) {
	const viewport = useRef<HTMLDivElement>(null);
	const pinned = useRef(live);
	const [held, setHeld] = useState<number | null>(null);
	const cut = useMemo(() => (live ? thinkingTail(text) : { tail: text, hidden: 0 }), [text, live]);
	const hidden = held !== null && held < cut.hidden ? held : cut.hidden;
	const tail = hidden === cut.hidden ? cut.tail : text.slice(hidden);

	useLayoutEffect(() => {
		const element = viewport.current;
		if (element && pinned.current) element.scrollTop = element.scrollHeight;
	}, [tail, live]);

	return (
		<Scroller
			className="max-h-[min(320px,40vh)]"
			overscroll="auto"
			scrollRef={viewport}
			onScroll={(element) => {
				pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 8;
				if (live && pinned.current !== (held === null)) setHeld(pinned.current ? null : hidden);
			}}
		>
			{live ? (
				<div className="whitespace-pre-wrap break-words text-label leading-[1.75] tracking-[0.025em] text-ink-faint">
					{hidden > 0 && <div className="mb-2 italic">{translate("thinking.earlier", { n: hidden.toLocaleString() })}</div>}
					{tail}
				</div>
			) : (
				<Markdown text={text} className="text-label text-ink-faint" />
			)}
		</Scroller>
	);
}
