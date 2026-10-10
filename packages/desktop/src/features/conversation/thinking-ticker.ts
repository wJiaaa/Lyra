/**
 * What of the reasoning is shown while it is still being written: the runs on the thinking
 * line's ticker, and the tail the open body keeps on screen.
 *
 * Kept apart from the component so it can be tested as text in, runs out. The ticker's
 * measuring needs a window, and is not where this goes wrong.
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

/**
 * The reasoning as a row of short runs, one per line the model wrote.
 *
 * The ticker is one line, so a line break cannot be a break — it becomes a wider gap in the
 * run, which is what "next thought" looks like when everything is on one line. Every break
 * counts, not only blank lines: models write their reasoning as numbered steps one per line,
 * and folding those together gives "1. Read the diff 2. Check the tests" with nothing to say
 * where one ends and the next begins.
 *
 * Markdown is stripped rather than rendered. Reasoning arrives as markdown — backticked
 * identifiers, bold, list markers — and on a ticker those characters are noise: a `**` reads
 * as a typo and a `#` as a heading whose shape nobody can see.
 */
export function thinkingRuns(text: string): string[] {
	const rawRuns = text
		.split("\n")
		.map((line) => plain(line).replace(/\s+/g, " ").trim())
		.filter((line) => line.length > 0);

	// Deduplicate consecutive identical runs so repeated headings/thoughts don't stack in the ticker.
	const deduped: string[] = [];
	for (const run of rawRuns) {
		if (deduped.length === 0 || deduped[deduped.length - 1] !== run) {
			deduped.push(run);
		}
	}
	return deduped;
}

function plain(line: string): string {
	return (
		line
			// A fence line carries no words; its language tag is not for reading.
			.replace(/^\s*```.*$/, "")
			// Block prefixes: heading marks, quote bars, bullets, numbered steps.
			.replace(/^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, "")
			// Emphasis keeps its words and loses its marks. The italic rule wants a non-word
			// character on both sides, so an `_` inside `snake_case` is left alone.
			.replace(/(\*\*|__)(.+?)\1/g, "$2")
			.replace(/(^|[^\w*])[*_]([^*_]+?)[*_](?=[^\w*]|$)/g, "$1$2")
			// Inline code without the ticks.
			.replace(/`([^`]+)`/g, "$1")
			// Links and images keep their label.
			.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
	);
}
