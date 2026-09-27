import type { Failure } from "../ai/failure.ts";

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
