import { useEffect, useState, type ReactNode } from "react";
import { useScopedTurnMeter } from "../../app/session-scope.tsx";
import { ChevronRight } from "../../ui/icons/index.ts";
import { Collapse } from "../../ui/layout/Collapse.tsx";
import { translate } from "../../i18n/translate.ts";
import { FlowTrail } from "./FlowRow.tsx";
import { useTranscriptDisclosure } from "./view-state.ts";

/**
 * 有过程的一轮：一行锚，过程挂在它下面，回答在外面（怎么分见 `grouping.ts` 的 `TurnBlock`）。
 *
 * 锚从这一轮的第一步起就在，说的是「已工作 1 分 41 秒」：跑着时秒数一直往上走，跑完停下。跑完不自动收：一段段活
 * 本来就各自收成一行、行上说着里面有什么，再把它们整个收进锚里，翻回来只剩一行「已工作」，看不出这一
 * 轮做过什么——试过。想收的人点锚，收不收记在这一轮上。
 *
 * 字在线上：锚是这一轮的标题，下面那条细线把过程和它隔开。收起之后线下面紧跟回答。
 *
 * 每一行各套一层 `Collapse`，不把过程整个装进一个盒子。一句中途说的话，说出来的时候是这一轮的最后
 * 一行、站在回答的位置上；模型接着干活，它就成了过程的一部分。换盒子等于卸掉重建：它会在原地再淡入
 * 一遍，展开着的东西也会合上。各自一层，变的只是它跟不跟着收。收起之后过程里的东西不留在 DOM 里
 * （`Collapse` 收完就放掉），一轮四百次调用收起来不花钱。
 */
export function TurnWork({ running, durationMs, stateKey, entries, trailing }: {
	/** 这一轮还在跑：锚不能点。 */
	running: boolean;
	/** 这一轮跑了多久，墙上的钟——见 `TurnStats.durationMs`。 */
	durationMs?: number;
	stateKey?: string;
	/** 锚下面的每一行；`fold` 的在锚被收起时跟着收。 */
	entries: { key: string; fold: boolean; node: ReactNode }[];
	/** 锚的行尾：这一轮派出去的子智能体的脸。 */
	trailing?: ReactNode;
}) {
	// 记的是「收起来了」：默认摊开，`useTranscriptDisclosure` 记下的是和默认不一样的那个选择。
	const [folded, setFolded] = useTranscriptDisclosure(stateKey && `${stateKey}:folded`);
	const open = !folded;
	const shown = running || open;

	return (
		<div data-ly-turn-process={running ? "running" : "done"} data-ly-turn-open={shown ? "" : undefined}>
			{/* 跑着和跑完是同一个元素：换元素就是卸掉重建，变形那一刻锚会闪一下。 */}
			<button
				type="button"
				disabled={running}
				onClick={() => setFolded((value) => !value)}
				aria-expanded={running ? undefined : open}
				aria-label={running ? undefined : translate("process.turn")}
				data-open={!running && open ? "" : undefined}
				className="ly-turn-anchor text-label text-ink-faint enabled:cursor-pointer enabled:hover:text-ink-muted"
			>
				{running ? <LiveWorked /> : <span>{worked(durationMs)}</span>}
				<FlowTrail>{trailing}</FlowTrail>
				{!running && <ChevronRight size={12} strokeWidth={2} className="ly-flow-chevron" aria-hidden />}
			</button>
			{entries.map((entry) => (
				<Collapse key={entry.key} open={shown || !entry.fold} bodyClassName="pt-2.5">
					{entry.node}
				</Collapse>
			))}
		</div>
	);
}

/**
 * 跑着的那一句：「已工作 12 秒」，一秒一秒往上走。
 *
 * 和跑完那句同一种说法，跑完那一下不换句子、只停表。读的是运行指示那块表（`useScopedTurnMeter`），
 * 两处的秒数是同一个数。自己走钟，只重绘这一小块。
 */
function LiveWorked() {
	const { startedAt } = useScopedTurnMeter();
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!startedAt) return;
		const timer = setInterval(() => setNow(Date.now()), 250);
		return () => clearInterval(timer);
	}, [startedAt]);
	return <span className="ly-glide">{startedAt ? worked(now - startedAt) : translate("turn.working")}</span>;
}

/** 秒向下取整，和思考行的「思考了 N 秒」同一种取法。说不出时长的只写「已工作」。 */
function worked(durationMs: number | undefined): string {
	if (durationMs === undefined || durationMs < 1000) return translate("turn.worked");
	const seconds = Math.floor(durationMs / 1000);
	if (seconds < 60) return translate("turn.workedSeconds", { n: seconds });
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return translate("turn.workedMinutes", { m: minutes, s: seconds % 60 });
	return translate("turn.workedHours", { h: Math.floor(minutes / 60), m: minutes % 60 });
}
