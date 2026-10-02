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
	private loopLive = false;
	/**
	 * Whether a steering message would be picked up right now: the loop is between `agent_start` and
	 * `agent_end`.
	 *
	 * Not a synonym for `running`, which is why it exists. Only the loop itself takes steering
	 * (`drainSteering`), and `running` covers a wider span — after the turn has said its last word
	 * there is still a wind-down, during which `running` is true and nobody is collecting any more.
	 * When the two were not separated: the window saw `agent_end` and sent the queued message, the
	 * main process saw `running` and pushed it into steering, and nothing ever took it. On screen it
	 * was "sent, and nothing happened"; the next send flushed it out along with itself, which looked
	 * like an old message being replayed.
	 *
	 * Flipped by `observe` at the session log's exit (see `AgentSession`'s constructor), so it is
	 * already false before `agent_end` reaches the window.
	 */
	get steerable(): boolean {
		return this.loopLive;
	}

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
		if (event.type === "agent_start") this.loopLive = true;
		else if (event.type === "agent_end") this.loopLive = false;
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

	/**
	 * Start a turn inside a hold. The signal is what `stop` aborts.
	 *
	 * Refused while a turn or a compaction holds the controller: two of them on one history would
	 * each write their own replies and boundaries over the other's, and the stop button would only
	 * reach the newer one. No path does this today — a submission while busy queues, and a resume
	 * finds the opening message already claimed — so reaching here is a bug to see, not to absorb.
	 */
	beginTurn(): AbortSignal {
		if (this.controller) throw new Error("A turn is already running on this session's history");
		this.controller = new AbortController();
		return this.controller.signal;
	}

	/** The turn's promise, so a caller can wait for its tools to finish writing. */
	trackTurn(turn: Promise<void>): void {
		if (!this.controller) throw new Error("trackTurn needs a turn begun with beginTurn");
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

	/**
	 * Run a manual compaction, stoppable like a turn.
	 *
	 * Refused while anything holds the session: a running turn keeps its own copy of the history and
	 * would write its boundary over this one at the end. `AgentSession.compact` answers that case
	 * with a message; this is the guard behind it.
	 */
	compact(run: (signal: AbortSignal) => Promise<CompactOutcome>): Promise<CompactOutcome> {
		if (this.running) throw new Error("Cannot compact while the session is running");
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
