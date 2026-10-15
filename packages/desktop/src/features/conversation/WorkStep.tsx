/**
 * 一段连着做的活，画成一行（怎么分段见 `grouping.ts` 的 `Step`）。
 *
 * - **一次调用**：这一行就是那次调用自己，和从前的工具行一模一样。
 * - **几次调用，或者调用前想过**：跑着时这一行说的是正在跑的那一次调用（「读取文件 safety.md」，模型给了
 *   `description` 就是它那句话），换一次滚一下，每一句至少挂 650ms（`useHeldKey`）；这一段不再长了（后面
 *   接上了回答或别的活），再滚成总的「思考 2 次 · 读取文件 12 个、搜索内容 5 个」。点开是挂在一条竖线上的
 *   每一次调用和每一段推理。
 *
 *   从前跑着时就说总的、新的一次接在句尾：一段探索跑一分钟，人只看得到几个数在涨，不知道它此刻在看
 *   什么。更早试过跑着时换成最新一步，那时是硬换，每来一次整行跳一下；之后改成 `RollWords` 的滚动，
 *   可来一次就滚一次，连着的 read、grep 一两百毫秒一换，字没读完就滚走了——所以有了停留时长。
 *
 * 行首是这一段第一次调用的图标，和它只有一次调用时那一行是同一枚：从一次长到两次，换的只有字。
 * 不写类名（「终端 ·」「探索 ·」）：摘要本来就以动作开头，「终端 · 执行命令 7 个」把一件事说了两遍，
 * 而一次调用的那一行又没有它，同一种东西两种长相。
 * - **末尾的推理还在写**：句尾接一句「正在思考 · 5s」，句子本身不动。推理不另起一行，所以不会有
 *   一行冒出来、几秒后又被收走——那是旧样子一跳一跳的来源。
 */

import { Fragment, useRef, type ReactNode } from "react";
import { CircleX } from "../../ui/icons/index.ts";
import { Collapse } from "../../ui/layout/Collapse.tsx";
import { useScopedFromToolRuns } from "../../app/session-scope.tsx";
import { translate } from "../../i18n/translate.ts";
import { FlowRow } from "./FlowRow.tsx";
import { LiveThought } from "./LiveThought.tsx";
import { ToolIcon } from "./tool-icons.tsx";
import { RollWords } from "../../ui/motion/RollWords.tsx";
import { useHeldKey } from "../../ui/motion/held.ts";
import { describeCalls, describeOne, diffOf } from "./call-words.ts";
import { thinkingLive, type Call, type Run, type Step } from "./grouping.ts";
import { useTranscriptDisclosure } from "./view-state.ts";

/**
 * 一次调用画成哪一行，交给转录（`LiveToolCard`）。
 *
 * 不在这里 import：`runs.tsx` 经文件预览、`ToolCard` 经 diff 视图、`ThinkingBlock` 经 Markdown，都会连回
 * 转录本身，这里引它们就是新的循环依赖。转录本来就引着它们，由它递进来。
 */
export type DrawCall = (call: Call, line?: { thinking?: ReactNode; extra?: ReactNode }) => ReactNode;

export function WorkStep({ step, live, draw, drawCall }: {
	step: Step;
	/** 这一段是不是这一轮此刻正在做的那一段：一轮还在跑，而它后面什么都还没有。 */
	live: boolean;
	/** 推理那一行怎么画，交给转录自己（`MessageRow`），这里不另做一份。 */
	draw: (run: Run) => ReactNode;
	drawCall: DrawCall;
}) {
	const tail = step.members[step.members.length - 1];
	const writing = live && tail?.kind === "thinking" && thinkingLive(tail.run) ? tail.run : null;
	const thinking = writing ? <LiveThought startedAt={startedAt(writing)} /> : undefined;

	const thought = step.members.filter((member) => member.kind === "thinking").length;

	/*
	 * 一次调用的那一行后面接上一段推理，这一段就从工具行换成合在一起的那一行：是换了一个元素。新的那一行
	 * 不从头量宽，而是从旧那一行此刻的字宽和行尾宽缓过去——不然箭头在换的那一帧往右跳一百多像素，句子也
	 * 不像是往后长，而是整句换了。
	 *
	 * 在换的那一次渲染里读，读的是屏幕上还挂着的旧那一行。不能在每次提交后记：工具行自己跑完、行尾冒出
	 * 「+N -M」时这里不重绘，记下的会是行尾还在从 0 起步那一刻的宽度。
	 */
	const box = useRef<HTMLDivElement>(null);
	const single = step.calls.length === 1 && thought === 0;
	const wasSingle = useRef(single);
	const from = useRef<{ words: number; trail: number } | null>(null);
	if (wasSingle.current && !single) {
		const row = box.current?.querySelector(".ly-flow-row");
		const words = row?.querySelector(".ly-roll-words");
		const trail = row?.querySelector(".ly-flow-trail");
		from.current = words && trail ? { words: words.getBoundingClientRect().width, trail: trail.getBoundingClientRect().width } : null;
	}
	wasSingle.current = single;

	if (single) {
		const thoughts = step.members.flatMap((member) => (member.kind === "thinking" ? [member.run] : []));
		return <div ref={box} data-ly-step={step.category}>{drawCall(step.calls[0], { thinking, extra: thoughts.length > 0 ? thoughts.map(draw) : undefined })}</div>;
	}
	return (
		<div ref={box}>
			<StepGroup step={step} thought={thought} live={live} thinking={thinking} from={from.current} draw={draw} drawCall={drawCall} />
		</div>
	);
}

/** 这一行说的是总的那一句，而不是某一次调用。调用的 id 不会是它。 */
const STEP = "step";

function StepGroup({ step, thought, live, thinking, from, draw, drawCall }: {
	step: Step;
	/** 原地被它接替的那一行画出来的宽度；没有就是这一段刚出现。 */
	from: { words: number; trail: number } | null;
	/** 这一段里的推理有几次：「思考 N 次」。 */
	thought: number;
	live: boolean;
	thinking?: ReactNode;
	draw: (run: Run) => ReactNode;
	drawCall: DrawCall;
}) {
	const [open, setOpen] = useTranscriptDisclosure(step.key);
	const { calls } = step;

	// 数和字，不是记录表本身：选出对象的选择器每次都是新的，别的卡片冒一行输出就会把这一行重画一遍。
	const added = useScopedFromToolRuns((runs) => calls.reduce((n, { block }) => n + diffOf(runs[block.id], "added"), 0));
	const removed = useScopedFromToolRuns((runs) => calls.reduce((n, { block }) => n + diffOf(runs[block.id], "removed"), 0));
	const failed = useScopedFromToolRuns((runs) => calls.some(({ block }) => runs[block.id]?.status === "error"));

	/*
	 * 跑着时说的那一次：第一个还在跑的调用，不是最后发出的那个。一次发出几个调用时它们各跑各的，最后那个
	 * 可能早跑完了、前面那个还在跑。一个都没在跑（两批之间、下一个还没开跑）就说最后那个。
	 */
	const running = useScopedFromToolRuns((runs) => calls.find(({ block }) => runs[block.id]?.status === "running")?.block.id);
	const want = live ? (running ?? calls[calls.length - 1].block.id) : STEP;
	// 每一句至少挂 `HOLD_MS`：一两百毫秒来一次的 read、grep 不再来一次滚一次，字读完了才换。从跑着换成总的也一样等。
	const held = useHeldKey(want);
	const said = held === STEP ? null : (calls.find(({ block }) => block.id === held) ?? calls[calls.length - 1]).block;
	// bash 给人看的那句话只在记录的 `summary` 里，参数里是命令本身。
	const saidSummary = useScopedFromToolRuns((runs) => (said ? runs[said.id]?.summary : undefined));

	// 哪样先来哪样在前：先有的那半句不能被后来的「思考 N 次」从前面挤开。
	const parts = [describeCalls(calls)];
	if (thought > 0) parts[step.members[0].kind === "thinking" ? "unshift" : "push"](translate("step.thinking", { n: thought }));
	const words = said ? describeOne(said, saidSummary) : parts.join(translate("step.separator"));
	// 换一次调用、或者从跑着换成总的，就是换了一句话，滚一下；同一次调用的参数还在流进来，只缓宽度。
	const rollKey = said ? `call-${said.id}` : STEP;
	// 一次调用的那一行后面只接上了推理：句子还是原地那一句，从旧宽度缓过来就够，不滚。
	const sameWords = from !== null && calls.length === 1;

	return (
		<div data-ly-step={step.category} data-ly-run={live ? "running" : "done"}>
			<FlowRow
				icon={<ToolIcon name={calls[0].block.name} />}
				/*
				 * 跑着时挂上的这一行滚进来（`enter`）：它接替的是原地那段推理，或者一次调用的那一行而这里已经是下一次
				 * 了，说的都是另一句话；从旧的宽度缓过去（`from`）。历史里挂上的不滚。光挂在字上而不是经 `running`
				 * 挂在外层，见 `RollWords`。
				 */
				summary={
					<RollWords rollKey={rollKey} text={words} from={from?.words} glide={live && !thinking} enter={live && !sameWords}>
						{words}
					</RollWords>
				}
				trailFrom={from?.trail}
				trailing={thinking || failed || added + removed > 0 ? (
					<span className="flex items-center gap-2">
						{thinking}
						{failed && <CircleX size={13} strokeWidth={1.9} className="text-danger/85" />}
						{added + removed > 0 && (
							<span className="font-mono text-caption">
								<span className="text-ok">+{added}</span> <span className="text-danger">-{removed}</span>
							</span>
						)}
					</span>
				) : undefined}
				open={open}
				onToggle={() => setOpen((value) => !value)}
				label={translate("tools.run")}
			/>
			{/* 竖线在行首图标的正下方，挂在上面的每一行读起来都属于这一行。 */}
			<Collapse open={open} bodyClassName="pt-2.5">
				<div data-ly-step-rail="" className="ml-[7px] flex flex-col gap-2.5 border-l border-line-soft pl-[14px]">
					{step.members.map((member) => (member.kind === "call" ? <Fragment key={member.call.block.id}>{drawCall(member.call)}</Fragment> : draw(member.run)))}
				</div>
			</Collapse>
		</div>
	);
}

function startedAt(run: Extract<Run, { kind: "message" }>): number | undefined {
	for (let at = run.upTo - 1; at >= (run.from ?? 0); at--) {
		const block = run.message.content[at];
		if (block?.type === "thinking") return block.startedAt;
	}
	return undefined;
}
