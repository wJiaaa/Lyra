/**
 * What of the reasoning the open body keeps on screen while it is still being written.
 *
 * Kept apart from the component so it can be tested as text in, tail out.
 */

/** How much of a reasoning still being written the open body keeps on screen, in characters. */
const LIVE_TAIL = 16_000;

/** How far the tail's start moves at a time. */
const TAIL_STEP = 4_000;

/**
 * The end of a reasoning still being written, and how many characters come before it.
 *
 * Only the end, because the whole of it costs the whole of it on every token: a five-minute
 * reasoning laid out in full ran the window at four frames a second (measured on a real 174k
 * one). The tail bounds that at the window, however long the model thinks; the full text is
 * there once it finishes.
 *
 * The start moves in steps rather than with every token, so the top of the window and the count
 * above it change once every few thousand characters instead of on every frame; and it moves to
 * the next line break when there is one close by, so the window does not open halfway through a
 * word. While the reader is scrolled up the body holds the start where it was (see `ThinkingBody`).
 */
export function thinkingTail(text: string, limit = LIVE_TAIL): { tail: string; hidden: number } {
	if (text.length <= limit) return { tail: text, hidden: 0 };
	let start = Math.ceil((text.length - limit) / TAIL_STEP) * TAIL_STEP;
	const lineEnd = text.indexOf("\n", start);
	if (lineEnd !== -1 && lineEnd - start < 200) start = lineEnd + 1;
	return { tail: text.slice(start), hidden: start };
}
