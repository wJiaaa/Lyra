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

import { deliveryMessage, type FinishedJob, type SettledDispatch } from "./sub-agent/delegation-waits.ts";
import type { SessionActivity } from "./session-activity.ts";
import type { SubAgentSummary } from "../types/sub-agent.ts";
import type { BackgroundJob, BackgroundJobs } from "../tools/background-jobs.ts";
import { readJob } from "../tools/bash.ts";
import type { Message, PeerLetter, UserContent } from "../types.ts";
import { peerMessage } from "./peer-letters.ts";

/**
 * How long background results are gathered before they are delivered.
 *
 * Several dispatched in parallel often finish one right after another — same model, similar work,
 * end times a few hundred milliseconds apart are common. Gathered for this short while, they are
 * one message and one turn; not gathered, they are several turns, each resending the whole prefix.
 * Any longer and the one that finished first waits for nothing: the person can see it is done,
 * yet the main session has not moved.
 */
const DELIVERY_GATHER_MS = 400;

export interface DeliveryDeps {
	activity: SessionActivity;
	jobs: () => BackgroundJobs;
	detail: (id: string) => SubAgentSummary | null;
	/** 还在后台跑、没回来的子代理：送达消息里点名，模型才知道还在等谁。 */
	outstanding: () => SubAgentSummary[];
	/** `followUp`：会话忙着时排到这一轮之后，而不是插进去。 */
	submit: (message: Message, deliver?: "followUp") => Promise<void>;
	/** 一次送达收了尾（送了或丢了）；会话据此重新看一眼自己是不是空闲了。 */
	settled: () => void;
}

export class SessionDeliveries {
	private reports: SettledDispatch[] = [];
	private finishedJobs: BackgroundJob[] = [];
	/** 其他会话发来的消息；和后台结果一起攒，一起送，见 `peer-letters.ts`。 */
	private letters: PeerLetter[] = [];
	/** 要排到收件方这一轮之后的那些：插进去会打断它手上的事，单独成一条、排队送。 */
	private queuedLetters: PeerLetter[] = [];
	private timer: ReturnType<typeof setTimeout> | null = null;
	/** 已经取出、还没交到会话手里的那一次送达；这期间也不算空闲。 */
	private flushing = false;
	private readonly deps: DeliveryDeps;

	constructor(deps: DeliveryDeps) {
		this.deps = deps;
	}

	/**
	 * A sub-agent that was let go has finished: hold it, and shortly deliver it together with any
	 * that finished around the same time.
	 */
	report(report: SettledDispatch): void {
		this.reports.push(report);
		this.schedule();
	}

	jobFinished(job: BackgroundJob): void {
		this.finishedJobs.push(job);
		this.schedule();
	}

	/** 另一个会话的消息到了；和同一时刻到的其他东西合成一条再送。 */
	letter(letter: PeerLetter, deliver: "steer" | "followUp" = "steer"): void {
		(deliver === "followUp" ? this.queuedLetters : this.letters).push(letter);
		this.schedule();
	}

	/** 没有攒着待送的东西。会话判断空闲时要看它：攒着的那一条四百毫秒后就会开一轮。 */
	get empty(): boolean {
		return this.timer === null && !this.flushing && this.reports.length === 0 && this.finishedJobs.length === 0 && this.letters.length === 0 && this.queuedLetters.length === 0;
	}

	/**
	 * After a stop, nothing still being held is delivered.
	 *
	 * A sub-agent that was stopped still "finishes" afterwards, and if something is waiting to
	 * deliver it at that moment, a result cut off halfway wakes the main session that was just
	 * stopped — the screen has only just said "stopped", and it starts moving again. Background
	 * commands are not stopped (the stop button is for this conversation, not for the dev server
	 * the person had it start), but they no longer wake the session when they end either: if the
	 * model needs the result next turn, it reads it itself with `bash_output`.
	 */
	clear(): void {
		this.reports.length = 0;
		this.finishedJobs.length = 0;
		this.letters.length = 0;
		this.queuedLetters.length = 0;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
	}

	/**
	 * Of the finished reports held for delivery, keep only those whose dispatch is still in the
	 * history. See `stopCutDelegations` in `session-rewind.ts`.
	 */
	keepOnly(dispatched: ReadonlySet<string>): void {
		this.reports = this.reports.filter((report) => dispatched.has(report.id));
	}

	private schedule(): void {
		this.timer ??= setTimeout(() => {
			this.timer = null;
			this.flushing = true;
			void this.flush().finally(() => {
				this.flushing = false;
				this.deps.settled();
			});
		}, DELIVERY_GATHER_MS);
	}

	/**
	 * Deliver the gathered background results to the main session as one message.
	 *
	 * If the main session is running it is spliced in — read at the start of the next turn; if it
	 * is idle a turn is started so it can go on with these conclusions. Ones a person stopped are
	 * not delivered: stopping it was the person's decision, and waking the main session with a
	 * half-finished result is arguing with that decision.
	 */
	private async flush(): Promise<void> {
		const settled = this.reports.splice(0, this.reports.length);
		const reports = settled
			.map((report) => ({ report, summary: this.deps.detail(report.id) }))
			.filter(({ report, summary }) => summary?.status !== "aborted" && !report.answer?.stoppedByUser);
		const jobs = this.takeFinishedJobs();
		const letters = this.letters.splice(0, this.letters.length);
		const queued = this.queuedLetters.splice(0, this.queuedLetters.length);
		if (reports.length === 0 && jobs.length === 0 && letters.length === 0 && queued.length === 0) return;
		const { activity } = this.deps;
		// A manual compaction is rewriting the history: wait until it has written the boundary
		// before coming in, the same as a message from the person.
		const mark = activity.mark();
		if (activity.compaction) await activity.compaction;
		/*
		 * The person pressed stop while this was waiting: these reports were already taken out, so
		 * `clear` cannot reach them. Drop them for the same reason, rather than putting them back.
		 */
		if (activity.stoppedSince(mark)) return;
		if (reports.length + jobs.length + letters.length > 0) {
			await this.deps.submit(combined(reports.length + jobs.length > 0 ? deliveryMessage(reports, jobs, reports.length > 0 ? this.deps.outstanding() : []) : null, letters));
		}
		// 会话闲着时这一条照样开一轮；忙着（或上面那条刚开了一轮）就排到那一轮之后。
		if (queued.length > 0) await this.deps.submit(peerMessage(queued), "followUp");
	}

	/**
	 * The gathered background commands, read into the shape used for delivery.
	 *
	 * Whether each is quiet is asked again at this moment: during those 400ms of gathering, the
	 * model may have already read the outcome itself with `bash_output`, or someone may have pressed
	 * stop in the services panel — delivering the former again is a repeat, and the latter would be
	 * arguing with that decision.
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

/**
 * 同一刻到的后台结果和来信合成一条：一条消息、一个回合。分开送的话，闲着的会话会为第一条开一轮，
 * 第二条排在后面再开一轮，每一轮都把整段前缀重发一遍。
 */
function combined(delivery: Message | null, letters: PeerLetter[]): Message {
	if (letters.length === 0 && delivery) return delivery;
	const mail = peerMessage(letters);
	if (!delivery || delivery.role !== "user" || mail.role !== "user") return mail;
	return { ...delivery, peer: letters, content: [...(mail.content as UserContent[]), ...(delivery.content as UserContent[])] };
}
