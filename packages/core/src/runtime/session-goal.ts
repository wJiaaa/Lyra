/**
 * 一个会话上的持续目标怎么推进。设计见 ADR-0045。
 *
 * 一轮干净收尾（`agent_end` 为 done）之后、会话闲下来时问一次裁判（`goal-judge.ts`）：
 * 到了就停、走不到就停、有进展就接着跑、在等就按退避睡一会儿再叫醒它。预算是三条硬线：
 * 最多看 `MAX_ROUNDS` 次、连着 `MAX_NO_PROGRESS` 次没进展、连着 `MAX_JUDGE_FAILURES` 次读不出结论，
 * 撞上哪条都停下来等人。被人按停、这一轮报错，同样停下——「别让循环替人做决定」。
 *
 * 状态全在 `SessionMeta.goal` 里，每次变化都落盘：进程死掉再起来，等着的目标按 `wakeAt` 接着等，
 * 跑到一半的目标留在原状态，下一轮收尾时再判。
 */

import type { AgentEvent } from "../agent/events.ts";
import { streamAssistant } from "../ai/index.ts";
import { agentProfile, GOAL_JUDGE_PROFILE, resolveModelRef } from "../config/model-choice.ts";
import { resolveModel } from "../config/settings.ts";
import type { Settings } from "../config/settings.ts";
import type { SessionRecordInput } from "../session/types.ts";
import type { TodoItem } from "../tools/todo.ts";
import type { GoalPauseReason, GoalState, GoalVerdict } from "../types/goal.ts";
import type { Message } from "../types.ts";
import { GOAL_JUDGE_TIMEOUT_MS, judgeGoal } from "./goal-judge.ts";

export const MAX_ROUNDS = 50;
export const MAX_NO_PROGRESS = 5;
export const MAX_JUDGE_FAILURES = 3;
/** 连着在等时每次睡多久；超过名单长度按最后一档。 */
export const WAIT_BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 600_000, 1_800_000];

export interface GoalDeps {
	settings(): Settings;
	goal(): GoalState | undefined;
	/** 写回 meta 并落盘；`undefined` 是取消。 */
	record(goal: GoalState | undefined): Promise<void>;
	messages(): Message[];
	todos(): TodoItem[];
	modelId(): string;
	/** 替换裁判那一次请求；不给就是真的服务商。 */
	stream?: typeof streamAssistant;
	append(record: SessionRecordInput): Promise<void>;
	emit(event: AgentEvent): Promise<void>;
	/** 以运行时的名义开一轮（`synthetic`）。 */
	continueWith(text: string): Promise<void>;
	idle(): boolean;
	whenIdle(): Promise<void>;
}

export function goalActive(goal: GoalState | undefined): goal is GoalState {
	return goal !== undefined && (goal.status === "working" || goal.status === "judging" || goal.status === "waiting");
}

export class SessionGoal {
	private readonly deps: GoalDeps;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private judge: AbortController | null = null;
	private disposed = false;

	constructor(deps: GoalDeps) {
		this.deps = deps;
	}

	/** 定一个目标。已有的（不管什么状态）被这一个替掉，计数从零起。 */
	async set(text: string): Promise<void> {
		this.cancelWake();
		this.judge?.abort();
		await this.write({ text: text.trim(), startedAt: Date.now(), status: "working", rounds: 0, noProgress: 0, judgeFailures: 0, waits: 0 });
	}

	/** 人取消了目标：整个拿掉，不留终态。 */
	async clear(): Promise<void> {
		this.cancelWake();
		this.judge?.abort();
		if (!this.deps.goal()) return;
		await this.write(undefined);
	}

	/**
	 * 一轮收尾了。只有干净收尾的才判；被停、报错、撞上步数或重复上限的，都是循环已经替人停下的
	 * 场合，目标跟着停，不再自己续。
	 */
	async afterTurn(reason: Extract<AgentEvent, { type: "agent_end" }>["reason"]): Promise<void> {
		const goal = this.deps.goal();
		if (!goalActive(goal) || this.disposed) return;
		if (reason !== "done") {
			await this.pause(goal, reason === "aborted" ? "stopped" : "error");
			return;
		}
		// 排着的任务、攒着的后台结果先走；它们本来就要开一轮，判了也白判。
		await this.deps.whenIdle();
		const current = this.deps.goal();
		if (this.disposed || !goalActive(current) || current.status === "judging" || !this.deps.idle()) return;
		await this.check(current);
	}

	/** 从磁盘回来：等着的接着等，到点了马上看。 */
	arm(): void {
		const goal = this.deps.goal();
		if (goal?.status === "waiting" && goal.wakeAt !== undefined) this.scheduleWake(goal.wakeAt);
	}

	/** 人按了停止：在等的、在判的都停下来等人；在跑的那一轮自己会以 aborted 收尾。 */
	interrupt(): void {
		this.judge?.abort();
		const goal = this.deps.goal();
		if (goal?.status === "waiting" || goal?.status === "judging") void this.pause(goal, "stopped");
	}

	dispose(): void {
		this.disposed = true;
		this.cancelWake();
		this.judge?.abort();
	}

	private async check(goal: GoalState): Promise<void> {
		const rounds = goal.rounds + 1;
		if (rounds > MAX_ROUNDS) {
			await this.pause({ ...goal, rounds: goal.rounds }, "budget");
			return;
		}
		await this.write({ ...goal, status: "judging", rounds, wakeAt: undefined });
		const verdict = await this.ask(goal);
		const after = this.deps.goal();
		// 判的时候目标被换掉或取消了，结论作废。
		if (this.disposed || !after || after.status !== "judging" || after.startedAt !== goal.startedAt) return;
		const judged: GoalState = { ...after, verdict: verdict ?? after.verdict };
		if (!verdict) {
			const judgeFailures = judged.judgeFailures + 1;
			if (judgeFailures >= MAX_JUDGE_FAILURES) { await this.pause({ ...judged, judgeFailures }, "judge-failed"); return; }
			await this.resume({ ...judged, judgeFailures }, `Goal check could not reach a verdict this time. Keep working toward the goal: ${goal.text}`);
			return;
		}
		switch (verdict.kind) {
			case "met":
				await this.end({ ...judged, judgeFailures: 0 }, "met");
				return;
			case "impossible":
				await this.end({ ...judged, judgeFailures: 0 }, "impossible");
				return;
			case "progress":
				await this.resume({ ...judged, judgeFailures: 0, noProgress: 0, waits: 0 }, `Goal check: not reached yet. ${verdict.reason}\nKeep working toward the goal: ${goal.text}`);
				return;
			case "stuck": {
				const noProgress = judged.noProgress + 1;
				if (noProgress >= MAX_NO_PROGRESS) { await this.pause({ ...judged, judgeFailures: 0, noProgress }, "no-progress"); return; }
				await this.resume({ ...judged, judgeFailures: 0, noProgress, waits: 0 }, `Goal check: the last turn did not move the goal forward. ${verdict.reason}\nChange approach and keep working toward the goal: ${goal.text}`);
				return;
			}
			case "waiting": {
				const waits = judged.waits + 1;
				const wakeAt = Date.now() + WAIT_BACKOFF_MS[Math.min(waits, WAIT_BACKOFF_MS.length) - 1];
				await this.write({ ...judged, judgeFailures: 0, waits, status: "waiting", wakeAt });
				this.scheduleWake(wakeAt);
				return;
			}
		}
	}

	private async ask(goal: GoalState): Promise<GoalVerdict | null> {
		const settings = this.deps.settings();
		const own = resolveModel(settings, this.deps.modelId() || settings.defaultModelId);
		if (!own) return null;
		const chosen = resolveModelRef(settings, agentProfile(settings, GOAL_JUDGE_PROFILE).modelId, own);
		const controller = new AbortController();
		this.judge = controller;
		try {
			const result = await judgeGoal({
				goal: goal.text,
				todos: this.deps.todos(),
				messages: this.deps.messages(),
				previous: goal.verdict,
				provider: chosen.provider,
				model: chosen.model,
				stream: this.deps.stream ?? streamAssistant,
				retryPolicy: () => this.deps.settings().retryPolicy,
				signal: AbortSignal.any([controller.signal, AbortSignal.timeout(GOAL_JUDGE_TIMEOUT_MS)]),
			});
			if (!result) return null;
			// 用量照记：读不出结论的那次服务商也收了钱。
			await this.deps.append({ type: "usage", source: "goal-judge", providerId: chosen.provider.id, modelId: chosen.model.modelId, usage: result.usage });
			return result.verdict;
		} catch {
			return null;
		} finally {
			if (this.judge === controller) this.judge = null;
		}
	}

	private async resume(goal: GoalState, text: string): Promise<void> {
		await this.write({ ...goal, status: "working", wakeAt: undefined });
		await this.deps.continueWith(text);
	}

	private scheduleWake(wakeAt: number): void {
		this.cancelWake();
		const delay = Math.max(0, wakeAt - Date.now());
		this.timer = setTimeout(() => {
			this.timer = null;
			void this.wake();
		}, delay);
		// 一个在等的目标不该拖着进程不退出。
		if (typeof this.timer === "object" && "unref" in this.timer) this.timer.unref();
	}

	private async wake(): Promise<void> {
		const goal = this.deps.goal();
		if (this.disposed || goal?.status !== "waiting") return;
		// 人在这期间开了口，让那一轮先跑；它收尾时会再判。
		if (!this.deps.idle()) return;
		const since = goal.verdict?.reason ? ` You were waiting for: ${goal.verdict.reason}` : "";
		await this.resume(
			goal,
			`Goal check: it is now ${new Date().toISOString()}.${since} Check whether it has happened and continue toward the goal: ${goal.text}\n` +
			"If it still has not happened, say what you are waiting for and stop.",
		);
	}

	private cancelWake(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
	}

	private async pause(goal: GoalState, why: GoalPauseReason): Promise<void> {
		this.cancelWake();
		await this.write({ ...goal, status: "paused", pausedFor: why, wakeAt: undefined, endedAt: Date.now() });
		await this.deps.emit({ type: "notice", level: "warn", message: `Goal paused (${why}) after ${goal.rounds} checks: ${goal.text}`, code: "goal-paused", params: { why, rounds: goal.rounds, goal: goal.text } });
	}

	private async end(goal: GoalState, status: "met" | "impossible"): Promise<void> {
		this.cancelWake();
		await this.write({ ...goal, status, wakeAt: undefined, endedAt: Date.now() });
		const reason = goal.verdict?.reason ?? "";
		await this.deps.emit(status === "met"
			? { type: "notice", level: "info", message: `Goal reached: ${goal.text}`, code: "goal-met", params: { goal: goal.text, reason } }
			: { type: "notice", level: "warn", message: `Goal cannot be reached from here: ${reason}`, code: "goal-impossible", params: { goal: goal.text, reason } });
	}

	private async write(goal: GoalState | undefined): Promise<void> {
		await this.deps.record(goal);
		await this.deps.emit({ type: "goal", goal: goal ?? null });
	}
}
