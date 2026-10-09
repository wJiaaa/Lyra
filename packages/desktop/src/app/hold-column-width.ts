/**
 * The conversation's text columns through a slide — the sidebar's, and the right column's in
 * `features/dock/column-slide.ts`: both edges taken from where they are to where they end, in a
 * straight line on the slide's own curve.
 *
 * Left to its pane, a column follows it with a flat stretch in it (`--ly-content` in `dock.css`), so
 * one click read as two motions — sliding at a fixed width, then widening as the pane crossed a
 * breakpoint. Held at its destination width from the first frame, it read as a jump instead: a
 * width that changes at once has to move one of its edges against the slide. Collapsing the sidebar
 * at 1440px, the right edge and the question bubble on it went 150px right, then slid back left.
 * So the width is eased along with the position, and the text rewraps as it goes — two edges each
 * moving one way read as one motion, where the jump read as two.
 *
 * Both ends are measured, not computed — the slide is seeked to its end and back — so nothing here
 * repeats the breakpoints or the gutters, and the panel column beside, whose text does not move, is
 * left alone. A column wider than its pane for now runs past the card's edge and is clipped there.
 */

/** The columns that read `--ly-content`. */
const COLUMN = '[class*="max-w-[var(--ly-content)]"]';

/** `NavPane`'s Tailwind `ease-out`, which the right column's slide copies. */
export const EASE_OUT = "cubic-bezier(0, 0, 0.2, 1)";

interface Place {
	left: number;
	width: number;
}

/** Whatever holds a column now, so a new slide over it can let go first. */
const holders = new WeakMap<HTMLElement, () => void>();
/** Where a column was drawn as it was let go, for a slide reversed halfway to carry on from. */
const handoff = new WeakMap<HTMLElement, Place>();

/** For the sidebar: `frame` is its frame, whose `margin-left` transition has just begun. */
export function holdColumnWidth(frame: HTMLElement): () => void {
	const main = frame.parentElement?.querySelector<HTMLElement>(":scope > main");
	const slide = frame.getAnimations().find((motion): motion is CSSTransition => motion instanceof CSSTransition && motion.transitionProperty === "margin-left");
	return main && slide ? holdColumns(main, slide) : () => {};
}

/**
 * Take every column under `scope` from where it is drawn now to its width and place where `slide`
 * ends, for as long as `slide` runs; hand back the release, which `slide` ending also calls.
 */
export function holdColumns(scope: HTMLElement, slide: Animation): () => void {
	const end = slide.effect?.getComputedTiming().endTime;
	const at = slide.currentTime;
	const columns = [...scope.querySelectorAll<HTMLElement>(COLUMN)].filter((column) => column.parentElement && column.offsetWidth > 0);
	if (typeof end !== "number" || typeof at !== "number" || !columns.length) return () => {};
	for (const column of columns) holders.get(column)?.();

	// Seeked straight back, before a frame or a microtask can see it finished.
	slide.currentTime = end;
	const after = columns.map(place);
	slide.currentTime = at;
	const before = columns.map((column) => handoff.get(column) ?? place(column));

	const held = columns.flatMap((column, i) => {
		const [from, to] = [before[i], after[i]];
		return Math.abs(from.left - to.left) < 0.5 && Math.abs(from.width - to.width) < 0.5 ? [] : [{ column, from, to }];
	});
	// `mx-auto` off, so the motion below is the only thing placing it.
	for (const { column } of held) Object.assign(column.style, { marginLeft: "0px", marginRight: "0px" });
	// Where a column with no margin sits: the start of its parent's content box. All written before any is read.
	const origins = held.map(({ column }) => place(column).left);
	const frame = ({ left, width }: Place, origin: number): Keyframe => ({ transform: `translateX(${left - origin}px)`, width: `${width}px`, minWidth: `${width}px`, maxWidth: `${width}px` });
	const motions = held.map(({ column, from, to }, i) =>
		// Same id as the slides: dragging a splitter or the window finishes them all (`freezeMotion`).
		column.animate([frame(from, origins[i]), frame(to, origins[i])], { id: "ly-dock-geometry", duration: end - at, easing: EASE_OUT, fill: "forwards" }),
	);

	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		const drawn = held.map(({ column }) => place(column));
		for (const [i, { column }] of held.entries()) {
			handoff.set(column, drawn[i]);
			motions[i].cancel();
			column.style.removeProperty("margin-left");
			column.style.removeProperty("margin-right");
			if (holders.get(column) === release) holders.delete(column);
		}
		// Only a slide taking over in the same task reads it.
		queueMicrotask(() => {
			for (const { column } of held) handoff.delete(column);
		});
	};
	for (const { column } of held) holders.set(column, release);
	slide.finished.then(release, release);
	return release;
}

/** A column's left edge from its parent's, as drawn, and its width. */
function place(column: HTMLElement): Place {
	const box = column.getBoundingClientRect();
	return { left: box.left - column.parentElement!.getBoundingClientRect().left, width: box.width };
}
