import { useEffect, useState } from "react";
import type { Message } from "@plume/core";
import { proseGrewAt, proseLength, STALL_MS } from "./answering.ts";

/**
 * True only while the answer is genuinely arriving; see `answering.ts` for why that is not the same
 * question as "does this reply contain text".
 *
 * The clock is the half that cannot be derived from the messages alone. Text that has stopped
 * growing looks exactly like text that grew a moment ago — the difference is how long ago, and
 * nothing re-renders to mark the passing of time on its own. So a timer is set for the moment the
 * stall will have lasted `STALL_MS`, and another chunk moves that moment on.
 *
 * Counted from when the text last grew (`proseGrewAt`), not from when this hook first saw it. Timed
 * from sight, switching to another conversation and back restarted the clock: a reply whose words
 * had stopped a minute ago hid the running line for another 2.5s, which is exactly when the model
 * has finished a paragraph and gone quiet to think.
 */
export function useAnswering(messages: Message[]): boolean {
	const at = proseLength(messages) === null ? undefined : proseGrewAt(messages[messages.length - 1]);
	// Nothing in the store changes when a stall begins, so the timer re-renders on its own.
	const [, wake] = useState(0);
	useEffect(() => {
		if (at === undefined) return;
		const left = STALL_MS - (Date.now() - at);
		if (left <= 0) return;
		const timer = setTimeout(() => wake((n) => n + 1), left);
		return () => clearTimeout(timer);
	}, [at]);
	return at !== undefined && Date.now() - at < STALL_MS;
}
