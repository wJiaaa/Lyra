import { Collapse } from "../../ui/layout/Collapse.tsx";
/**
 * 一整轮的过程，收成一行。
 *
 * 一轮读下来是「想 → 做 → 说」。过程值得看一次——正在跑的时候你就想看着它——但看过之后，翻回
 * 一段旧对话时四十行工具卡片挡在答案前面就只是噪音了。所以这一行是过程的开关。
 *
 * 收起时它必须说清楚里面是什么，否则就是把东西藏起来而已。说的是名词不是事件：「思考 3 次 ·
 * 读取文件 5 个、执行命令」，而不是「12 个步骤」——没人见过那 12 个步骤。全是思考、一个工具都没调
 * 时它说「思考了一会儿」，因为那时候确实没有别的可说。
 *
 * 行的骨架和思考行、工具行是同一个（见 `FlowRow`），里面的过程挂在左边一条竖线下面。
 */

import { Layers } from "lucide-react";
import { useLayoutEffect } from "react";

import { FlowRow } from "./FlowRow.tsx";
import { translate } from "../../i18n/translate.ts";
import { useTranscriptDisclosure } from "./view-state.ts";
import { useCallChain } from "./call-chain.ts";

export function TurnProcess({
	counts,
	work,
	running,
	stateKey,
	children,
	trailing,
}: {
	counts: { tools: number; thinking: number };
	/** What the calls in this turn did, in words — see `describeRun`. Falls back to a bare count. */
	work?: string;
	/** 收起那一行的行尾：这一轮派出去的子智能体的脸。 */
	trailing?: React.ReactNode;
	/** 正在跑的那一轮默认摊开——那时候人是在看着它的。 */
	running: boolean;
	stateKey?: string;
	children: React.ReactNode;
}) {
	const [open, setOpen] = useTranscriptDisclosure(stateKey);
	const chain = useCallChain();

	/*
	 * Open while it runs, and left open once it ends.
	 *
	 * The line used to be absent while the turn ran and appear only when it ended, folding the work
	 * away in the same frame. That did two things at the moment someone was reading: it pushed the
	 * whole turn down by a row, and it took away what they were looking at. Drawn from the start, the
	 * line carries the running tally and works as a toggle throughout, so the reason for hiding it —
	 * a switch that did nothing while the turn ran — no longer holds.
	 *
	 * Recorded as an ordinary "opened" choice, so a person can still close it mid-run and it stays
	 * closed. Turns never seen running (history read from disk) keep the old default: folded.
	 * A layout effect, so a turn mounted mid-run never paints one folded frame first.
	 */
	useLayoutEffect(() => {
		if (running && chain === "collapsed") setOpen(() => true);
		// oxlint-disable-next-line react-hooks/exhaustive-deps -- only the start of a run opens it; `setOpen` is rebuilt every render
	}, [running, chain]);

	if (chain === "expanded") {
		// The earlier layout: no line while the turn runs (it is shown in full), folded once it ends.
		const shown = running || open;
		return (
			<div data-ly-turn-process={running ? "running" : "done"} data-ly-turn-open={shown ? "" : undefined}>
				{!running && (
					<FlowRow
						icon={<Layers size={13} strokeWidth={1.8} />}
						summary={countsOnly(counts)}
						trailing={trailing}
						label={translate("process.turn")}
						open={shown}
						onToggle={() => setOpen((value) => !value)}
					/>
				)}
				<Collapse open={shown} bodyClassName={running ? "flex flex-col gap-2.5" : "flex flex-col gap-2.5 pt-2.5"}>{children}</Collapse>
			</div>
		);
	}

	return (
		<div data-ly-turn-process={running ? "running" : "done"} data-ly-turn-open={open ? "" : undefined}>
			<FlowRow
				icon={<Layers size={13} strokeWidth={1.8} />}
				summary={
					// The words change as calls land; the key keeps the fade on the words. See `FlowRow`.
					<span key={summarize(counts, work)} className="ly-fade-in">
						{summarize(counts, work)}
					</span>
				}
				trailing={trailing}
				label={translate("process.turn")}
				open={open}
				onToggle={() => setOpen((value) => !value)}
			/>

			<Collapse open={open} bodyClassName="pt-2.5">
				{/* The rail sits under the header's icon, so everything inside reads as belonging to it. */}
				<div data-ly-process-rail="" className="ml-[7px] flex flex-col gap-2.5 border-l border-line-soft pl-[14px]">
					{children}
				</div>
			</Collapse>
		</div>
	);
}

/** The earlier line: how many calls, then how many thoughts. */
function countsOnly(counts: { tools: number; thinking: number }): string {
	const parts: string[] = [];
	if (counts.tools > 0) parts.push(translate("turnProcess.tools", { n: counts.tools }));
	if (counts.thinking > 0) parts.push(translate("turnProcess.thinking", { n: counts.thinking }));
	return parts.length > 0 ? parts.join(translate("turnProcess.separator")) : translate("turnProcess.thoughtOnly");
}

/** 里面有什么，用名词说。 */
function summarize(counts: { tools: number; thinking: number }, work?: string): string {
	const parts: string[] = [];
	if (counts.thinking > 0) parts.push(translate("turnProcess.thinking", { n: counts.thinking }));
	if (counts.tools > 0) parts.push(work || translate("turnProcess.tools", { n: counts.tools }));
	// 一个工具都没调，那就只有想过——这时候「N 个步骤」是句空话。
	return parts.length > 0 ? parts.join(translate("turnProcess.separator")) : translate("turnProcess.thoughtOnly");
}
