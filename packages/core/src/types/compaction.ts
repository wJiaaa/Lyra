import type { Failure } from "../ai/failure.ts";
import type { Message } from "./message.ts";

/** Keep classifications, never provider bodies which may echo credentials or prompt content. */
export interface CompactionFault {
	kind: Failure["kind"] | "empty" | "no_reduction" | "unknown";
	hint?: Failure["hint"];
}

type CompactionProgress =
	| { phase: "summarizing"; provider: string; model: string }
	| { phase: "retrying"; delayMs: number; fault: CompactionFault }
	| { phase: "fallback"; fault: CompactionFault };

export interface CompactionObserver {
	signal?: AbortSignal;
	progress(event: CompactionProgress): Promise<void>;
}

export interface AutoCompactionState {
	phase: CompactionProgress["phase"];
	retries: number;
	provider?: string;
	model?: string;
	delayMs?: number;
	before?: number;
	after?: number;
	fault?: CompactionFault;
	outcome?: "summary" | "fallback";
}

/**
 * Compaction's result: the history to send, and everything needed to store the decision.
 *
 * The messages alone were what compaction used to return, and that is precisely what made it
 * non-durable — the caller could apply the result but had no way to write it down, because the
 * summary was buried inside a synthetic message and the boundary was implicit in the array's
 * length. Both are stated here.
 */
export interface Compaction {
	/** The history the model should be given from now on. */
	messages: Message[];
	/**
	 * The summary text, so the session can store it and rebuild this history later.
	 *
	 * Empty when history was discarded without one — the summariser was unreachable and dropping
	 * the oldest turns was the only way to get under the line. The boundary still moved, so it is
	 * still recorded; what is missing is the account of what was behind it.
	 */
	summary: string;
	/**
	 * How many real messages survived, counted from the newest.
	 *
	 * A count rather than an index, because the array this was computed from is the loop's own —
	 * already compacted, possibly more than once — while the boundary has to be resolved against
	 * the session log, which holds every original message. An index into one means nothing in the
	 * other; "the last N still apply" means the same thing in both.
	 *
	 * Absent when nothing was summarised away. Pruning oversized tool results rewrites messages
	 * without removing any, so it changes what is sent and not where history begins. 它不能靠
	 * 「下一轮再剪一次」补回来：下一轮的压缩判断读的是这次剪过之后的 usage，不会再触发，原文
	 * 就照发了。剪过的副本由 `compactStep` 交给会话的 `AgedToolPruner` 记住，摘要时保留尾部同理。
	 */
	kept?: number;
}
