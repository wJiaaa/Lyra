/**
 * Token estimation, kept free of any runtime the browser does not have.
 *
 * Its own module rather than part of `runtime/compaction.ts`, and reachable as
 * `@plume/core/tokens`, because both sides of the app need it: the runtime to decide when
 * to compact, and the renderer to show how full the context window is. Importing it from the
 * package root would drag in the whole kernel — the bash tool, settings, the plugin loader —
 * and the first thing that happens then is `process is not defined`, with a white window.
 */

import type { Message, Usage } from "./types.ts";

/**
 * What a conversation actually spent, as opposed to what it re-read.
 *
 * `Usage.total` weighs all four buckets equally. That is the right answer to "how many tokens
 * crossed the wire" and the wrong answer to the question anyone actually asks of it, because cache
 * reads bill at a tenth of the input rate and, in a long agentic run, outnumber everything else
 * twenty to one. A session that re-read a 220k context two thousand times reported half a billion
 * tokens beside a 95% hit rate — two figures describing the same fact, the alarming one first —
 * when the fresh input behind it was under thirty million.
 *
 * Cache *writes* count as fresh: that is the first, full-price pass over the content, not a re-read
 * of it. Only `cacheRead` is left out.
 *
 * Beside `total` rather than replacing it. `total` is what was written to every historical log, and
 * a stored field that means one thing before a date and another after is worse than either.
 *
 * Here rather than next to `Usage` in `types/message.ts` for the reason at the top of this file:
 * the renderer needs it, and may not reach the package root to get it.
 */
export function freshTokens(usage: Pick<Usage, "input" | "output" | "cacheWrite">): number {
	return usage.input + usage.cacheWrite + usage.output;
}

export function estimateTokens(messages: Message[]): number {
	let chars = 0;
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const c of message.content) {
				if (c.type === "text") chars += c.text.length;
				else if (c.type === "thinking") chars += c.thinking.length;
				else chars += (c.argumentsText ?? JSON.stringify(c.arguments)).length + c.name.length;
			}
		} else {
			for (const c of message.content) {
				// A base64 image is worth roughly 1500 tokens regardless of its byte length.
				chars += c.type === "text" ? c.text.length : 6000;
			}
		}
	}
	// ~3.5 characters per token averaged over code and prose.
	return Math.ceil(chars / 3.5);
}
