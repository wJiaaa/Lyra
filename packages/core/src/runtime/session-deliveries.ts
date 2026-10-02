/**
 * Results that finish in the background, carried back into the conversation.
 *
 * Two sources: sub-agents the parent stopped waiting for (`delegation-waits.ts`), and background
 * commands that ended (`tools/background-jobs.ts`). Both are gathered for a moment and handed to the
 * session as one message — mid-turn it is spliced in, idle it starts a turn.
 *
 * Kept out of `AgentSession` because it needs four things from it and nothing else: a way to submit,
 * the roster to check a report against, the background-job registry, and the session's activity to
 * know whether a stop happened meanwhile.
 */

import { deliveryMessage, type FinishedJob, type SettledDispatch } from "./delegation-waits.ts";
import type { SessionActivity } from "./session-activity.ts";
import type { SubAgentSummary } from "../types/sub-agent.ts";
import type { BackgroundJob, BackgroundJobs } from "../tools/background-jobs.ts";
import { readJob } from "../tools/bash.ts";
import type { Message } from "../types.ts";

/**
 * 后台结果攒多久再送。
 *
 * 并行派出去的几个常常前后脚跑完——同一个模型、差不多的活，结束时间差几百毫秒是常事。攒这么
 * 一小会儿，它们就是一条消息、一个回合；不攒，就是几个回合，每一个都把整段前缀重发一遍。再长
 * 就是让先跑完的那个白等：人看得见它已经结束了，主会话却还没动。
 */
const DELIVERY_GATHER_MS = 400;

export interface DeliveryDeps {
	activity: SessionActivity;
	jobs: () => BackgroundJobs;
	detail: (id: string) => SubAgentSummary | null;
	submit: (message: Message) => Promise<void>;
}

export class SessionDeliveries {
	private reports: SettledDispatch[] = [];
	private finishedJobs: BackgroundJob[] = [];
	private timer: ReturnType<typeof setTimeout> | null = null;
	private readonly deps: DeliveryDeps;

	constructor(deps: DeliveryDeps) {
		this.deps = deps;
	}

	/** 一个放了手的子代理跑完了：先攒着，一小会儿之后连同前后脚跑完的一起送。 */
	report(report: SettledDispatch): void {
		this.reports.push(report);
		this.schedule();
	}

	jobFinished(job: BackgroundJob): void {
		this.finishedJobs.push(job);
		this.schedule();
	}

	/**
	 * 停止之后，攒着没送的都不送了。
	 *
	 * 被停下的子代理停下之后照样会「跑完」，而跑完的那一刻如果还有人等着送，一份被腰斩的结果会把
	 * 刚刚停下的主会话又叫醒——屏幕上刚说完「已停止」，它又动起来了。后台命令不停（停止按钮管的是
	 * 这场对话，不是人让它起的开发服务器），但它们结束时也不再叫醒会话：模型下一轮要知道结果，
	 * 自己用 `bash_output` 去读。
	 */
	clear(): void {
		this.reports.length = 0;
		this.finishedJobs.length = 0;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
	}

	/** 已经跑完、正攒着等送的，只留派发还在历史里的那些。见 `AgentSession.stopCutDelegations`。 */
	keepOnly(dispatched: ReadonlySet<string>): void {
		this.reports = this.reports.filter((report) => dispatched.has(report.id));
	}

	private schedule(): void {
		this.timer ??= setTimeout(() => {
			this.timer = null;
			void this.flush();
		}, DELIVERY_GATHER_MS);
	}

	/**
	 * 把攒下的后台结果作为一条消息送回主会话。
	 *
	 * 主会话正在跑就插进去——下一个回合开头读到；闲着就开一个回合，让它接着用这些结论。被人
	 * 按停的不送：停它是人的决定，拿一份半截的结果去叫醒主会话，是在跟那个决定争辩。
	 */
	private async flush(): Promise<void> {
		const settled = this.reports.splice(0, this.reports.length);
		const reports = settled
			.map((report) => ({ report, summary: this.deps.detail(report.id) }))
			.filter(({ report, summary }) => summary?.status !== "aborted" && !report.answer?.stoppedByUser);
		const jobs = this.takeFinishedJobs();
		if (reports.length === 0 && jobs.length === 0) return;
		const { activity } = this.deps;
		// 手动压缩正在改写历史：等它写完边界再进来，和人发消息一样。
		const mark = activity.mark();
		if (activity.compaction) await activity.compaction;
		/*
		 * 等的时候人按了停止：这批报告已经取出来了，`clear` 够不着它们。按同一个道理丢掉，不放回去。
		 */
		if (activity.stoppedSince(mark)) return;
		await this.deps.submit(deliveryMessage(reports, jobs));
	}

	/**
	 * 攒下的后台命令，读成送达用的样子。
	 *
	 * 是否安静在这一刻再问一遍：攒着的那 400ms 里，模型可能已经自己用 `bash_output` 读到了结局，或者
	 * 有人在服务面板上点了停止——前者再送是重复，后者是在跟那个决定争辩。
	 */
	private takeFinishedJobs(): FinishedJob[] {
		const registry = this.deps.jobs();
		return this.finishedJobs
			.splice(0, this.finishedJobs.length)
			.filter((job) => !registry.isQuiet(job.id))
			.map((job) => {
				registry.observed(job.id);
				const { status, text } = readJob(job);
				return { id: job.id, command: job.command, description: job.description, exitCode: job.exitCode, status, failed: job.status === "failed", output: text };
			});
	}
}
