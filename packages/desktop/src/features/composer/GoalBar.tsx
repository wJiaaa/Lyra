import type { GoalState } from "@plume/core";
import { useEffect, useState } from "react";
import { Crosshair, X } from "../../ui/icons/index.ts";
import { Button } from "../../ui/primitives/Button.tsx";
import { ScrollText } from "../../ui/scroll/ScrollText.tsx";
import { useApp } from "../../store/index.ts";
import { useI18n } from "../../i18n/index.ts";
import { GOAL_MAX_ROUNDS, goalStatusText, goalTone, type GoalTone } from "../../lib/goal-status.ts";

const TONE: Record<GoalTone, string> = {
	active: "text-accent",
	ok: "text-ok",
	danger: "text-danger",
	quiet: "text-ink-muted",
};

/**
 * 持续目标的状态条，托盘里项目那一行的上面。
 *
 * 放进托盘而不是在卡片外另起一条：托盘就是卡片背后露出来的那一层，项目和分支已经住在这里，
 * 「这次在哪儿做」和「这次要做到什么」是同一类背景信息，再加一层底色或阴影就是两件事了。
 * 终态（达成、走不到、停下）也留着，人要看见结果；点取消才消失。
 */
export function GoalBar({ sessionId, goal, last }: { sessionId: string; goal: GoalState; last: boolean }) {
	const { t } = useI18n();
	const now = useNow(goal.status === "waiting");
	const tone = TONE[goalTone(goal)];
	return (
		<div data-ly-goal={goal.status} className={`flex items-center gap-2 px-1.5 pt-1.5 ${last ? "pb-1.5" : ""}`}>
			{/* 左边距和下面那颗项目芯片的图标对齐（`Chip` 是 `pl-3`）。 */}
			<div className="ly-composer-control flex min-w-0 flex-1 items-center gap-2 pl-3 text-label">
				<Crosshair size={16} strokeWidth={1.8} className={`shrink-0 ${tone}`} aria-hidden />
				<ScrollText text={goal.text} className="min-w-0 text-ink" />
				<span data-ly-goal-status="" className={`shrink-0 whitespace-nowrap tabular-nums ${tone}`}>{goalStatusText(goal, now)}</span>
				{goal.rounds > 0 && (
					<span data-ly-goal-rounds="" className="shrink-0 whitespace-nowrap tabular-nums text-detail text-ink-faint">
						{t("goal.rounds", { n: goal.rounds, max: GOAL_MAX_ROUNDS })}
					</span>
				)}
			</div>
			{/* `subtle` 而不是带描边的 `ghost`：托盘本身就是一层底，按钮再框一圈就是在底上又画了一道边。 */}
			<Button variant="subtle" size="sm" icon={<X size={13} aria-hidden />} onClick={() => void useApp.getState().setGoal(null, sessionId)}>
				{t("goal.cancel")}
			</Button>
		</div>
	);
}

/** 只在倒计时时每秒走一次；别的状态不需要时钟，也不该每秒重画。 */
function useNow(ticking: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!ticking) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [ticking]);
	return now;
}
