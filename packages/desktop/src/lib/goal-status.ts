/**
 * 输入框上方那条目标状态条要说的话：现在在干什么、还要等多久、停下的原因。
 *
 * 和组件分开，是因为这里是规则（哪种状态说哪句、倒计时怎么取整），要单独测；组件只管摆。
 */

import type { GoalState } from "@plume/core";
import { translate } from "../i18n/translate.ts";
import { goalPauseText } from "./notice-text.ts";

/**
 * 判定次数的上限。值得自己记一份而不是从 core 拿：渲染进程不能从 core 根入口导入值（会把
 * `node:fs` 拉进浏览器），而这一个数不值得为它开子入口。`test/goal-status.test.ts` 守着它和
 * core 的 `MAX_ROUNDS` 一致。
 */
export const GOAL_MAX_ROUNDS = 50;

/** 在做、在判、在等是进行中；其余三种是结果，要人再开口。 */
export function goalActive(goal: GoalState): boolean {
	return goal.status === "working" || goal.status === "judging" || goal.status === "waiting";
}

/** 还要等多久，`m:ss`。退避最长 30 分钟，用不到小时。 */
export function goalCountdown(wakeAt: number, now: number): string | null {
	const left = wakeAt - now;
	if (left <= 0) return null;
	// 向上取整：还剩 0.4 秒时写 0:00 读起来像已经到了，其实还没醒。
	const seconds = Math.ceil(left / 1000);
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function goalStatusText(goal: GoalState, now: number): string {
	switch (goal.status) {
		case "working": return translate("goal.working");
		case "judging": return translate("goal.judging");
		case "waiting": {
			const time = goal.wakeAt === undefined ? null : goalCountdown(goal.wakeAt, now);
			// 到点了但还没醒（会话正忙，醒来那一下让路了）：说「马上」，不说一个 0:00。
			return time ? translate("goal.waiting", { time }) : translate("goal.waitingSoon");
		}
		case "paused": return translate("goal.paused", { why: goalPauseText(goal.pausedFor) });
		case "met": return translate("goal.met");
		case "impossible": return translate("goal.impossible");
	}
}

export type GoalTone = "active" | "ok" | "danger" | "quiet";

/** 进行中用强调色；达成是绿；走不到是红；停下等人不算错，用灰。 */
export function goalTone(goal: GoalState): GoalTone {
	if (goalActive(goal)) return "active";
	if (goal.status === "met") return "ok";
	if (goal.status === "impossible") return "danger";
	return "quiet";
}
