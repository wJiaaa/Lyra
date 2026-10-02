/**
 * Who holds a session's history right now, and how to stop them.
 *
 * Three things can hold it, and while any does nothing else may start a turn:
 *
 * - a **hold** — a prompt, or the opening message resumed after a restart — from its first write to
 *   the transcript until its last queued follow-up has run;
 * - a **turn** inside a hold, which is what the stop button aborts;
 * - a **manual compaction**, which rewrites the history and must not race a turn that is reading it.
 *
 * These used to be eight fields on `AgentSession` (`acceptingPrompt`, `activePrompt`,
 * `pendingResume`, `controller`, `activeTurn`, `compactionTask`, `abortEpoch`, `steerable`) whose
 * legal combinations were nowhere written down. One was wrong: the prompt and the resume shared one
 * `acceptingPrompt` flag, so whichever finished first marked the session idle while the other still
 * held it.
 */

import type { AgentEvent } from "../agent/events.ts";

export type HoldKind = "prompt" | "resume";

export interface CompactOutcome {
	ok: boolean;
	reason?: string;
	before?: number;
	after?: number;
}

export class SessionActivity {
	private readonly holds = new Map<HoldKind, Promise<void>>();
	/**
	 * Holds reserved but not yet finished. Counted apart from `holds` because a hold is reserved
	 * before its work starts — a submission that arrives during the first disk write has to queue.
	 */
	private reserved = 0;
	/** Whatever can be stopped right now: the running turn, or a manual compaction. */
	private controller: AbortController | null = null;
	private turn: Promise<void> | null = null;
	private compactionTask: Promise<CompactOutcome> | null = null;
	/** Bumped by every stop. Work that awaited something compares marks before acting on it. */
	private stops = 0;
	/**
	 * 此刻插话还有没有人接：loop 在 `agent_start` 与 `agent_end` 之间。
	 *
	 * 不是 `running` 的同义词，这正是它存在的理由。取走插话的只有 loop 自己（`drainSteering`）；
	 * `running` 管的范围要大一圈——回合说完之后还有一段收尾，那段时间里 `running` 还是 true，而
	 * 取件人已经下班了。这一格没分开的时候：窗口收到 `agent_end` 就把排着的那条送出来，主进程照着
	 * `running` 把它塞进插话，然后再没有人来取——屏幕上是「发出去了但一点反应都没有」，下一次发送时
	 * 它又被顺带倒出来，看起来像旧话重放。
	 *
	 * 由会话日志的出口调 `observe` 翻牌（见 `AgentSession` 的构造函数），`agent_end` 发到窗口之前
	 * 这里就已经是 false。
	 */
	steerable = false;

	get running(): boolean {
		return this.reserved > 0 || this.controller !== null;
	}

	/** A stop was asked for and the thing it stopped has not let go yet. */
	get stopping(): boolean {
		return this.controller?.signal.aborted ?? false;
	}

	/** The manual compaction in progress, which a prompt waits out before writing anything. */
	get compaction(): Promise<CompactOutcome> | null {
		return this.compactionTask;
	}

	/** Track the loop's own start and end; see `steerable`. */
	observe(event: AgentEvent): void {
		if (event.type === "agent_start") this.steerable = true;
		else if (event.type === "agent_end") this.steerable = false;
	}

	/** Hold the session for `work`. Reserved before `work` runs its first line. */
	hold(kind: HoldKind, work: () => Promise<void>): Promise<void> {
		this.reserved += 1;
		let held: Promise<void>;
		try {
			held = work();
		} catch (error) {
			held = Promise.reject(error);
		}
		const tracked = held.finally(() => {
			this.reserved -= 1;
			if (this.holds.get(kind) === tracked) this.holds.delete(kind);
		});
		this.holds.set(kind, tracked);
		return tracked;
	}

	/** The hold of this kind still in progress. */
	holding(kind: HoldKind): Promise<void> | null {
		return this.holds.get(kind) ?? null;
	}

	/** Start a turn inside a hold. The signal is what `stop` aborts. */
	beginTurn(): AbortSignal {
		this.controller = new AbortController();
		return this.controller.signal;
	}

	/** The turn's promise, so a caller can wait for its tools to finish writing. */
	trackTurn(turn: Promise<void>): void {
		this.turn = turn;
	}

	endTurn(): void {
		this.turn = null;
		this.controller = null;
	}

	/** Wait for the prompt hold and the turn inside it, in that order. Rejections propagate. */
	async settled(): Promise<void> {
		await this.holding("prompt");
		await this.turn;
	}

	/** Run a manual compaction, stoppable like a turn. The caller has checked that nothing is running. */
	compact(run: (signal: AbortSignal) => Promise<CompactOutcome>): Promise<CompactOutcome> {
		const controller = new AbortController();
		this.controller = controller;
		const task = run(controller.signal).finally(() => {
			this.controller = null;
			this.compactionTask = null;
		});
		this.compactionTask = task;
		return task;
	}

	/** Stop whatever is running. Work holding a `mark` from before this sees it through `stoppedSince`. */
	stop(): void {
		this.stops += 1;
		this.controller?.abort();
	}

	mark(): number {
		return this.stops;
	}

	stoppedSince(mark: number): boolean {
		return this.stops !== mark;
	}
}
