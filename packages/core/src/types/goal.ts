/**
 * 持续目标：人给一句目标，每一轮收尾由一次独立的裁判请求判定「做到没有」，没做到就接着跑，
 * 要等外面的事就按退避睡一会儿再看。设计见 ADR-0045。
 */

export type GoalVerdictKind =
	/** 达成了，而且是报告里能看出来的，不是嘴上说的。 */
	| "met"
	/** 从这里走不到：缺的是只有人能给的东西。 */
	| "impossible"
	/** 没到，但这一轮往前走了。 */
	| "progress"
	/** 没到，这一轮也没往前走。 */
	| "stuck"
	/** 下一步要等外面的事（作业没跑完、回复没来、时间没到）。 */
	| "waiting";

export interface GoalVerdict {
	kind: GoalVerdictKind;
	/** 裁判写给模型的一两句：还差什么、下一步做什么、在等什么。 */
	reason: string;
	at: number;
}

/** 为什么停下来等人。`stopped` 是人按了停止，`user` 是人直接取消了目标。 */
export type GoalPauseReason = "budget" | "no-progress" | "judge-failed" | "stopped" | "error" | "user";

export interface GoalState {
	text: string;
	startedAt: number;
	/**
	 * `working` 一轮在跑或马上要跑；`judging` 裁判在看；`waiting` 睡到 `wakeAt`；其余三个是终态，
	 * 要人再开口。
	 */
	status: "working" | "judging" | "waiting" | "paused" | "met" | "impossible";
	/** 裁判看过几次；也是预算的计数。 */
	rounds: number;
	/** 连续几次「没进展」。 */
	noProgress: number;
	/** 连续几次裁判的回答读不出结论。 */
	judgeFailures: number;
	/** 连续几次「在等」；退避按它算。 */
	waits: number;
	wakeAt?: number;
	verdict?: GoalVerdict;
	pausedFor?: GoalPauseReason;
	endedAt?: number;
}
