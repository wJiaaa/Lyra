import { Collapse } from "../../ui/layout/Collapse.tsx";
import { translate } from "../../i18n/translate.ts";
import { Brain } from "../../ui/icons/index.ts";
import { formatElapsed } from "@plume/client-runtime/running";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { FlowRow } from "./FlowRow.tsx";
import { Markdown } from "./Markdown.tsx";
import { thinkingTail } from "./thinking-ticker.ts";
import { Scroller } from "../../ui/scroll/Scroller.tsx";
import { useRolled } from "../../ui/motion/RollingText.tsx";
import { useTranscriptDisclosure } from "./view-state.ts";

/**
 * 模型的推理，收在一条流水行里。
 *
 * 和它下面那段工具活、那条命令是同一个骨架（见 `FlowRow`）：同样的 16px 图标槽、同样的行高。
 *
 * 行上只写标题，不写推理本身。它曾经把推理一句一句打在行上、写完停在第一句：一段几分钟的推理在那一行
 * 上滚个不停，是整屏最吵的东西，而那一句半截话几乎从来不是读者要的——要看推理的人会点开。
 * 运行中是「一个说『在想』的词 · 这段想了几秒」，词随想的时长往下换（见 `LiveThought`）；写完是
 * 「思考了 N 秒」，一个不会动的数，却说得出这段推理有多长。点开是全文。
 *
 * 运行中的秒数和下面那行运行指示的钟不是一回事：那个从这一轮开始算，跑过几个工具之后再想，它就回答
 * 不了「这一段想了多久」。
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
	/** 这段推理开始的时刻（`ThinkingContent.startedAt`），运行中拿它走秒、选词。 */
	startedAt?: number;
	/** 这段推理想了多久（`ThinkingContent.durationMs`）。旧会话、中途断掉的推理没有。 */
	durationMs?: number;
	stateKey?: string;
}) {
	const [open, setOpen] = useTranscriptDisclosure(stateKey);

	if (!text && !redacted) return null;

	return (
		<div data-ly-thinking="">
			{/*
			 * 运行中不经 `running` 上扫光：那道光挂在 `ScrollText` 装字的外层，而换词时滚进来的词带着
			 * transform 被单独合成，外层的 `background-clip: text` 裁不到它，滚动那一下词会整个消失。
			 * 光由 `LiveThought` 挂在词自己身上。
			 */}
			<FlowRow
				icon={<Brain size={13} strokeWidth={1.8} />}
				summary={redacted ? translate("thinking.redacted") : live ? <LiveThought startedAt={startedAt} /> : thoughtFor(durationMs)}
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

/**
 * 运行中的词，按这一段已经想了多久往下走：`[从第几毫秒起, 词]`。
 *
 * 间隔越拉越长（8、12、20、30、40 秒）。短推理只会看到一两个词；长推理每一步都比上一步停得久，
 * 不会变成它曾经那种每隔几秒换一次字的吵。按时长选而不是随机，重绘、切会话回来重新挂载都是同一个词。
 */
const LIVE_STEPS = [
	[0, "thinking.live"],
	[8_000, "thinking.live3"],
	[20_000, "thinking.live2"],
	[40_000, "thinking.live4"],
	[70_000, "thinking.live5"],
	[110_000, "thinking.live6"],
] as const;

/** 走完一遍以后，每隔这么久再换一个。停在最后一个词上几分钟不动，看上去和卡住了一样。 */
const LIVE_CYCLE_MS = 45_000;

function liveWord(elapsedMs: number): (typeof LIVE_STEPS)[number][1] {
	const last = LIVE_STEPS.length - 1;
	const lastAt = LIVE_STEPS[last][0];
	if (elapsedMs >= lastAt) {
		// 轮回时跳过开场的「正在思考」：想了两分钟以后再说一遍它，读着像刚开始。
		const round = Math.floor((elapsedMs - lastAt) / LIVE_CYCLE_MS);
		return LIVE_STEPS[1 + ((last - 1 + round) % last)][1];
	}
	let step = 0;
	while (step < last && elapsedMs >= LIVE_STEPS[step + 1][0]) step++;
	return LIVE_STEPS[step][1];
}

/**
 * 运行中那一行：「正在思考 · 5s」。
 *
 * 自己走钟，只重绘这一小块——放在 `ThinkingBlock` 里的话，每次走秒都把展开着的正文一起重绘一遍。
 * 四分之一秒一跳，和运行指示一样，秒位不会看上去跳过一格。
 *
 * 换词时新词从上方落进来（`ly-roll-in`），词框的宽度跟着平滑地变，后面的秒数被推过去而不是跳过去。
 * 秒数本身不滚：它是读数不是标签，每秒滚一次就成了眼角一直在动的东西（见 `RollingText`）。
 *
 * 说不出开始时刻时不报秒，词停在第一个。
 */
function LiveThought({ startedAt }: { startedAt: number | undefined }) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (startedAt === undefined) return;
		const timer = setInterval(() => setNow(Date.now()), 250);
		return () => clearInterval(timer);
	}, [startedAt]);

	const elapsed = startedAt === undefined ? 0 : now - startedAt;
	const word = translate(liveWord(elapsed));
	const rolls = useRolled(word);
	const box = useRef<HTMLSpanElement>(null);
	const width = useRef<number | null>(null);

	/*
	 * 宽度只在换词的那一下钉成像素：量出新宽，先钉回旧宽、再设新宽，过渡走完（`onTransitionEnd`）就放回
	 * auto。一直钉着的话，网页字体晚到、改字号之后词框还是旧的宽度，字会被截掉。
	 */
	useLayoutEffect(() => {
		const element = box.current;
		if (!element) return;
		element.style.width = "";
		const to = element.offsetWidth;
		const from = width.current;
		width.current = to;
		if (from === null || from === to) return;
		element.style.width = `${from}px`;
		void element.offsetWidth;
		element.style.width = `${to}px`;
	}, [word]);

	return (
		<span className="inline-flex items-center">
			<span
				ref={box}
				className="ly-thought-word"
				onTransitionEnd={(event) => {
					if (event.target === event.currentTarget) event.currentTarget.style.width = "";
				}}
			>
				<span key={word} className={`inline-block ${rolls ? "ly-thought-roll" : ""}`}>
					<span className="ly-glide">{word}</span>
				</span>
			</span>
			{startedAt !== undefined && (
				<>
					<span className="ly-flow-dot" aria-hidden />
					<span className="tabular-nums">{formatElapsed(elapsed)}</span>
				</>
			)}
		</span>
	);
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
