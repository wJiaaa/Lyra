/** How deep the softening reaches. The bottom is the edge content moves through — a list grows
 *  downwards, a transcript streams into it — and a shallow fade there reads as a cut. */
const FADE_TOP = 36;
const FADE_BOTTOM = 48;

/** Keep the middle readable even when several dock panes share a short window. */
export function scrollFade(height: number, edge: "top" | "bottom"): number {
	return Math.min(edge === "top" ? FADE_TOP : FADE_BOTTOM, Math.max(0, height) / 5);
}
