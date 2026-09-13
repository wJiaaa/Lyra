/**
 * Which words in the old code are the same words in the new code.
 *
 * Switching the preview's language replaces every character on screen. Done as a cut, it reads as
 * the panel blinking; what the eye wants is to see that `Counter` is still `Counter` and merely
 * moved. So the two token streams are paired, the pairs travel to their new positions, and
 * everything else fades — which is the whole of the effect, and the only part of it that needs a
 * decision.
 *
 * Pure, and separate from the animation, because the decision is where the mistakes are and a
 * pure function can be checked at the boundaries instead of watched.
 */

/** Anything with text and a position in the stream. Both `Piece` and a plain token satisfy it. */
export interface Movable {
	text: string;
}

/**
 * How short a word may be and still be worth following.
 *
 * Two. Punctuation, brackets and single letters occur by the hundred in any two samples and pair
 * up arbitrarily — `(` in Go's line 3 with `(` in Rust's line 11 — so following them produces a
 * screenful of crossing flight paths that say nothing about the code. Words of two or more are
 * rare enough that a pair usually *is* the same thing.
 */
const MIN_LENGTH = 2;

/** Whitespace never moves: it is the gap between things rather than a thing. */
const isWord = (text: string): boolean => text.trim().length >= MIN_LENGTH;

/**
 * Pair the old stream's words with the new one's, in order.
 *
 * Same text, matched first-to-first. Order matters and repeats are common — a sample with three
 * `count`s has three of them in both languages — so pairing by identity alone would be ambiguous
 * and pairing greedily by position would cross the paths over each other. First-to-first within
 * each word is what keeps them parallel.
 *
 * Returns new-index → old-index. Indexes are into the flat streams, which is what the renderer
 * marks its spans with.
 */
export function pairWords(before: Movable[], after: Movable[]): Map<number, number> {
	/** Where each word appears in the old stream, oldest first. */
	const queued = new Map<string, number[]>();
	before.forEach((piece, index) => {
		if (!isWord(piece.text)) return;
		const key = piece.text.trim();
		const at = queued.get(key);
		if (at) at.push(index);
		else queued.set(key, [index]);
	});

	const pairs = new Map<number, number>();
	after.forEach((piece, index) => {
		if (!isWord(piece.text)) return;
		const waiting = queued.get(piece.text.trim());
		if (!waiting || waiting.length === 0) return;
		// Shift, not pop: the first `count` in the old code pairs with the first in the new.
		pairs.set(index, waiting.shift()!);
	});
	return pairs;
}

/** A rectangle, as much of one as a move needs. */
export interface Spot {
	left: number;
	top: number;
}

/**
 * How far each paired word has to travel, in pixels.
 *
 * Given where the words *were* and where they now *are*, so the caller reads both sets of
 * positions before writing any style — reading and writing in turn is what makes the browser lay
 * the document out once per token instead of once per switch.
 *
 * Pairs that did not move are dropped. A transform of zero still costs a composited layer and a
 * transition that fires for nothing, and in two samples of the same program most of the matched
 * words are exactly where they were.
 */
export function travels(
	pairs: Map<number, number>,
	was: Map<number, Spot>,
	now: Map<number, Spot>,
): Map<number, { dx: number; dy: number }> {
	const moves = new Map<number, { dx: number; dy: number }>();
	for (const [after, before] of pairs) {
		const from = was.get(before);
		const to = now.get(after);
		if (!from || !to) continue;
		const dx = from.left - to.left;
		const dy = from.top - to.top;
		// Sub-pixel drift is not a movement anyone can see.
		if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
		moves.set(after, { dx, dy });
	}
	return moves;
}
