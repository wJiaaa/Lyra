/**
 * Whether a settled preview card follows a later height its page reports — see `PreviewCard`.
 */

/** A page whose height depends on its own height would otherwise resize forever. */
export const MAX_ADJUSTMENTS = 8;
/** Growth smaller than this is the page agreeing with the card, not content that got cut off. */
const GROWTH_SLACK = 8;

/**
 * The card's next height, or `null` to stay where it is.
 *
 * At the width the card settled at, the page may only ask for more: it is being measured at its own
 * height, and "exactly what I was given" is what every elastic layout answers. A new width is a new
 * measurement, though, in either direction — the column narrowed for a panel and the page rewrapped
 * taller, and when the panel closed the card kept that height over a stretch of nothing.
 *
 * Following width both ways cannot loop: a taller card can bring in the transcript's scrollbar and
 * narrow the column, but narrower only makes the page taller still, which keeps the scrollbar there.
 */
export function followHeight({ current, next, resized, adjustments }: {
	current: number;
	/** What the page asked for, already clamped to what a card may be. */
	next: number;
	/** Measured at another width than the last report. */
	resized: boolean;
	/** Changes since the width last changed. */
	adjustments: number;
}): number | null {
	if (resized) return next === current ? null : next;
	if (next <= current + GROWTH_SLACK || adjustments >= MAX_ADJUSTMENTS) return null;
	return next;
}
