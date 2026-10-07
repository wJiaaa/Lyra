/**
 * 一轮外面那一行「已工作 Ns」，照 t3code 的交互。
 *
 * 跑的时候它是这一轮的头：贴在人发的那句话底下，表在走，内容照常排在线下面。跑完之后同一个位置
 * 变成开关，回答之前的一切收在它里面，线下只露出回答。
 *
 * 它只说这一轮花了多久——里面有什么，点开后那些过程行自己会说。点开后的内容和没有这一行时一模一样，
 * 由调用链的两种排法决定（见 `wholeTurns`）。
 *
 * 右边是这一轮开始的时刻，和 t3code、和每条消息底下的时间一样，悬停才出来：它沿着整页重复，常亮
 * 就会和对话抢眼。它不在开关里面——点它不该把这一轮收起或展开。
 *
 * 线单独一个元素：`FlowRow` 的行高锁在 24px（见 flow-row.css），边框画在行上会把字挤出去。
 */

import { useEffect, useState } from "react";

import { Collapse } from "../../ui/layout/Collapse.tsx";
import { translate } from "../../i18n/translate.ts";
import { useScopedTurnMeter } from "../../app/session-scope.tsx";
import { FlowRow } from "./FlowRow.tsx";
import { formatSentAt, formatSpan, formatTimestampTip } from "./MessageActions.tsx";
import { formatElapsed } from "./RunningIndicator.tsx";
import { useTranscriptDisclosure } from "./view-state.ts";
import { useI18n } from "../../i18n/index.ts";
import { Text } from "../../ui/primitives/Text.tsx";

export function TurnElapsed({
	running,
	durationMs,
	startedAt,
	stateKey,
	children,
}: {
	running: boolean;
	/** 跑完的这一轮用了多久；和回答底下的徽章同一个数。 */
	durationMs?: number;
	/** 这一轮开始的时刻。 */
	startedAt?: number;
	stateKey: string;
	children: React.ReactNode;
}) {
	const [open, setOpen] = useTranscriptDisclosure(stateKey);
	const { resolvedLocale } = useI18n();
	const rule = <div data-ly-turn-rule="" aria-hidden className="mt-2 border-b border-line-soft" />;

	if (running) {
		return (
			<div data-ly-turn-elapsed="running">
				<LiveElapsed />
				{rule}
			</div>
		);
	}
	return (
		<div data-ly-turn-elapsed="done" data-ly-turn-open={open ? "" : undefined}>
			{/* 时刻只跟着这一行出来：挂在整块上的话，点开后鼠标停在里面任何地方它都会冒出来。 */}
			<div data-ly-turn-head="" className="group/turn relative">
				{startedAt !== undefined && (
					<span
						data-ly-turn-started=""
						data-ly-tip={formatTimestampTip(startedAt, resolvedLocale)}
						className="absolute top-0 right-0 flex h-6 items-center opacity-0 transition-opacity duration-[var(--ly-t-quick)] group-hover/turn:opacity-100 group-has-[:focus-visible]/turn:opacity-100"
					>
						<Text size="caption" tone="faint" numeric>
							{formatSentAt(startedAt, resolvedLocale)}
						</Text>
					</span>
				)}
				<FlowRow
					summary={translate("turnProcess.worked", { d: formatSpan(durationMs ?? 0) })}
					label={translate("process.turn")}
					open={open}
					onToggle={() => setOpen((value) => !value)}
				/>
			</div>
			{rule}
			<Collapse open={open} bodyClassName="flex flex-col gap-2.5 pt-2.5">
				{children}
			</Collapse>
		</div>
	);
}

/** 跑着的表。和运行指示器读的是同一个起点，所以收场那一刻数字接得上。 */
function LiveElapsed() {
	const { startedAt } = useScopedTurnMeter();
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!startedAt) return;
		// 四分之一秒一跳，秒位才不会看上去漏掉一个数。
		const timer = setInterval(() => setNow(Date.now()), 250);
		return () => clearInterval(timer);
	}, [startedAt]);
	return <FlowRow summary={translate("turnProcess.working", { d: formatElapsed(startedAt ? now - startedAt : 0) })} />;
}
