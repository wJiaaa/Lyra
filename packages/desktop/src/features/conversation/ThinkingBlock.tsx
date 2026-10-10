import { Collapse } from "../../ui/layout/Collapse.tsx";
import { translate } from "../../i18n/translate.ts";
import { Brain } from "../../ui/icons/index.ts";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";

import { FADE } from "./FadeText.tsx";
import { FlowRow } from "./FlowRow.tsx";
import { Markdown } from "./Markdown.tsx";
import { motionReduced } from "../../ui/motion/reduced.ts";
import { thinkingRuns, thinkingTail } from "./thinking-ticker.ts";
import { Scroller } from "../../ui/scroll/Scroller.tsx";
import { useTranscriptDisclosure } from "./view-state.ts";

/**
 * How fast the line writes itself out, in characters per second.
 *
 * The line has no pace of its own unless it is given one, and without it the speed becomes a
 * function of how much turned up at once: a provider that flushes six hundred characters in one
 * frame throws them past in the same instant it takes to ease six. Measured against a real relay —
 * 1024 frames of one turn — the summary changed three times. Three paragraphs, each landing whole.
 * That is not printing, it is three jump cuts.
 *
 * So the text is revealed a character at a time and the rate comes from how far behind the line is.
 * A floor, because a trickle should still look deliberate rather than stall; a ceiling, because
 * past roughly three or four characters a frame there is nothing to read, only a blur travelling
 * left. Between them it is "clear the backlog in `catchUp` seconds", which keeps a steady stream
 * about two thirds of a second behind the model — close enough to feel live, far enough behind to
 * actually be writing.
 */
const TYPE = {
	/** Characters per second when there is barely anything waiting. */
	floor: 42,
	/** Characters per second at full tilt: about 3.5 a frame, which is as fast as reading survives. */
	ceiling: 210,
	/** Seconds allowed to absorb whatever is waiting; the rate follows from it. */
	catchUp: 0.9,
} as const;

/**
 * 模型的推理，收在一条流水行里。
 *
 * 和它下面那段工具活、那条命令是同一个骨架（见 `FlowRow`）：同样的 16px 图标槽、同样的行高、
 * 一个图标加一句话，没有标签。一轮对话读下来是「想 → 做 → 说」，这三步在屏幕上必须长得像三步，
 * 而不是像三个互不相干的控件。
 *
 * 运行中它自己把字写出来——这是它「在动」的说法，所以不再另外加扫光：一行上只有一种动效。写到
 * 一半的字尾被顶在右边，看到的永远是最新的那几个字。停下来之后它就是一条普通的收起行：开头那句
 * 话，装不下就两头化开，鼠标放上去它自己读出来（见 `FlowRow` 里的 `ScrollText`）。点开是全文。
 */
export function ThinkingBlock({ text, redacted, live, stateKey }: { text: string; redacted: boolean; live?: boolean; stateKey?: string }) {
	const [open, setOpen] = useTranscriptDisclosure(stateKey);
	const runs = useMemo(() => thinkingRuns(text), [text]);
	const span = useRef<HTMLSpanElement>(null);
	/*
	 * 关掉动效时不写字，直接给最新的一句。
	 *
	 * 这里没有「时长可以缩短」的东西，只有「帧可以不跑」——正是 `motionReduced` 那份注释说的情形。
	 */
	const typing = live === true && !motionReduced();
	useTyped(runs, typing, span);

	if (!text && !redacted) return null;

	/*
	 * 正在写的时候，React 渲染空字符串，这个 span 归帧循环管。
	 *
	 * 在这里渲染当前那一句的话，下一个 token 到达时 React 会把循环刚写进去的字覆盖掉。
	 */
	const settled = live ? (typing ? "" : runs[runs.length - 1] ?? "") : runs[0] ?? text;

	return (
		<div data-ly-thinking="">
			{/*
			 * 不再写「思考过程 ·」。
			 *
			 * 那四个字说的是「这里有推理」，而左边那个脑子图标已经说了同一件事；它旁边的工具行是
			 * 「🔧 更新清单、列出目录」——图标加一句话，没有标签。思考行多出一个标签和一个点，就
			 * 变成了「标签：取值」的表单样子，和自己的兄弟行不是同一种东西，连着排下来那一块就散了。
			 *
			 * 读者要从这一行拿到的是模型在想什么，那就让整行都是它在想什么。
			 */}
			<FlowRow
				icon={<Brain size={13} strokeWidth={1.8} />}
				summary={
					redacted ? (
						translate("thinking.redacted")
					) : (
						<span ref={span}>{settled}</span>
					)
				}
				followEnd={typing}
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
					{hidden > 0 && <div className="mb-2 italic">{translate("thinking.earlier", { count: hidden.toLocaleString() })}</div>}
					{tail}
				</div>
			) : (
				<Markdown text={text} className="text-label text-ink-faint" />
			)}
		</Scroller>
	);
}

/**
 * 最新的那一句，一个字一个字写进 DOM。
 *
 * 全程不经过 React，这是重点。每个 token 本来就已经重渲染这个组件一次；为了写一个 DOM 已经知道
 * 的字符串，每帧再多跑一遍 React，正是 ticker 和 stutter 的区别。
 *
 * 循环通过 ref 读 `runs`，不通过依赖。依赖文本的 effect 会在每个 token 被拆掉重建，而重建正是丢帧、
 * 让行首反复弹回去的地方。
 *
 * 新写的字和正文一样淡入（见 `FadeText`），也是直接在 DOM 上做：新字各是一个淡入的 span，淡完就并回
 * 开头那段纯文本，行里始终只有正在淡的那几个 span。
 */
function useTyped(runs: string[], live: boolean, span: RefObject<HTMLSpanElement | null>): void {
	const state = useRef({ runs, total: 0, shown: 0 });
	state.current.runs = runs;
	state.current.total = runs.reduce((n, run) => n + run.length, 0);

	useEffect(() => {
		if (!live) return;
		let raf = 0;
		let last = performance.now();
		const fading: { span: HTMLSpanElement; born: number }[] = [];
		let row: HTMLElement | null = null;
		let widest = 0;
		const step = (now: number) => {
			// 夹住，免得一个切到后台的窗口回来时把缺席的那段时间一帧花完。
			const delta = Math.min(0.1, Math.max(0, (now - last) / 1000));
			last = now;
			const here = state.current;
			if (here.shown > here.total) here.shown = here.total;
			const backlog = here.total - here.shown;
			if (backlog > 0) {
				const rate = Math.min(TYPE.ceiling, Math.max(TYPE.floor, backlog / TYPE.catchUp));
				here.shown = Math.min(here.total, here.shown + rate * delta);
				const next = revealed(here.runs, here.shown);
				const element = span.current;
				if (element && element.textContent !== next) {
					write(element, next, now, delta * 1000, fading);
					/*
					 * 这一句现在有没有超出行宽——超出了才给两头加渐隐。
					 *
					 * 常驻的渐隐会把短句子的开头几个字平白抹淡：不溢出的时候字是从容器左边开始写的，
					 * 那里没有东西正在退场，化开就只是糊。谁溢出谁才化。
					 *
					 * 顺手量，不另起一个循环：这一帧刚写完字，布局本来就要重算一次；换成
					 * `ResizeObserver` 或者定时器反而要多算一次，还会晚一帧。
					 */
					const shell = element.parentElement;
					if (shell) {
						const clipped = element.getBoundingClientRect().width > shell.clientWidth + 0.5;
						if (clipped !== shell.hasAttribute("data-clipped")) shell.toggleAttribute("data-clipped", clipped);
					}
					/*
					 * 写着的时候，这一行只变宽不变窄。
					 *
					 * 行是按内容宽的（`flow-row.css` 的 `fit-content`），而换一句就清空重写：整行从一整列
					 * 缩回只剩图标，箭头跳回左边再被字一路推回去，一段几分钟的推理里来回几十次；正好在
					 * 那一刻点行中间，点到的是空白。到过的宽度就留着，换句时字从左边重写，箭头和可点的
					 * 范围原地不动。`100%` 封顶，是因为 `min-width` 压过 `max-width`，列变窄时不能撑出去。
					 * 写完就还给 `fit-content`：那时摘要换成第一句，宽度本来就要变。
					 */
					row ??= element.closest<HTMLElement>(".ly-flow-row");
					const width = row?.getBoundingClientRect().width ?? 0;
					if (row && width > widest + 0.5) {
						widest = width;
						row.style.minWidth = `min(${Math.ceil(width)}px, 100%)`;
					}
				}
			}
			// 淡完的字并回纯文本。没有新字的帧也要做，不然最后几个字一直是 span。
			while (fading.length > 0 && now - fading[0].born >= FADE) {
				const { span: done } = fading.shift()!;
				const head = done.parentElement?.firstChild;
				if (head?.nodeType === TEXT_NODE) head.nodeValue += done.textContent ?? "";
				done.remove();
			}
			raf = requestAnimationFrame(step);
		};
		raf = requestAnimationFrame(step);
		return () => {
			cancelAnimationFrame(raf);
			row?.style.removeProperty("min-width");
		};
	}, [live, span]);
}

/** `Node.TEXT_NODE`。 */
const TEXT_NODE = 3;

/**
 * 把这一行写成 `next`。接着上一句往后写的，只把多出来的字追加成淡入的 span，在这一帧的时长里错开；
 * 换了一句就清空重写。开头放一个文本节点，淡完的字并到它里面。
 */
function write(element: HTMLSpanElement, next: string, now: number, frame: number, fading: { span: HTMLSpanElement; born: number }[]): void {
	const current = element.textContent ?? "";
	const from = next.startsWith(current) ? current.length : 0;
	if (from === 0) {
		element.textContent = "";
		fading.length = 0;
	}
	if (element.firstChild?.nodeType !== TEXT_NODE) element.prepend(document.createTextNode(""));
	const fresh = Array.from(next.slice(from));
	fresh.forEach((char, index) => {
		const born = now + (index * frame) / fresh.length;
		const span = document.createElement("span");
		span.className = "ly-fade-char";
		span.style.animationDelay = `${Math.round(born - now)}ms`;
		span.textContent = char;
		element.append(span);
		fading.push({ span, born });
	});
}

/**
 * 写到第 `shown` 个字时，屏幕上是哪一句、写了多少。
 *
 * 句子按顺序消耗，所以就是这个计数落在的那一句。正好落在边界上时保持上一句，而不是开始下一句：
 * 还没开始的句子渲染出来是空串，一行摘要在两段之间闪一下空白，读起来像是它死了。
 */
function revealed(runs: string[], shown: number): string {
	let left = Math.floor(shown);
	let held = "";
	for (const run of runs) {
		if (left <= 0) break;
		if (left < run.length) return run.slice(0, left);
		left -= run.length;
		held = run;
	}
	return held;
}
