import { compactIfNeeded } from "../../runtime/compaction.ts";
import type { Compaction } from "../../types/compaction.ts";
import type { Context, Plugin } from "../context.ts";
import { COMPACTION, type CompactionRequest, type CompactionStrategy } from "../services.ts";

/**
 * Summarise the middle, keep the ends.
 *
 * The built-in answer to a full window: the oldest turns become a summary, the most recent ones
 * survive verbatim. It reads well afterwards and it is cheap, which is most of why it is the
 * default — but it is a policy, and a long-running agent with a different shape of work may want
 * a different one.
 */
class SummaryCompaction implements CompactionStrategy {
	compact(request: CompactionRequest): Promise<Compaction | null> {
		/*
		 * The request goes over whole; the defaults live in `compactIfNeeded`.
		 *
		 * This used to pass the first four fields positionally and let `compactIfNeeded` default the
		 * rest, which meant that binding the built-in strategy — what the desktop does at boot —
		 * turned off the overhead accounting, artifact storage and the `compact` model. The built-in
		 * policy should behave the same whether or not a context is in the picture, and handing over
		 * the object is what leaves no field to forget.
		 */
		return compactIfNeeded(request);
	}
}

export const compactionPlugin: Plugin = {
	name: "compaction",
	apply(ctx: Context) {
		return ctx.provide<CompactionStrategy>(COMPACTION, new SummaryCompaction());
	},
};
