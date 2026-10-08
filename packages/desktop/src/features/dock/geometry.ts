import type { PaneKind } from "./tree.ts";

/**
 * The numbers the dock is built out of.
 *
 * Kept apart from the components so the pure layout code — the tree, the fitting — can be read
 * and tested without pulling React in behind them.
 */

/**
 * How thin a pane may get, as a share of its row or column.
 *
 * A *share*, not a pixel count, because that is what the tree stores: pixels would have to be
 * recomputed and re-normalised on every window resize, and the rounding drift from doing that
 * repeatedly is what makes a layout creep. The pixel floor is a separate, simpler thing —
 * `min-width`/`min-height` on the pane itself, enforced by the browser.
 *
 * 8% rather than something smaller: below this a pane is a sliver you cannot read or aim at.
 */
export const MIN_FRACTION = 0.08;

/**
 * How small a pane may be drawn, in pixels.
 *
 * A share cannot express this. 8% of a wide window is a usable column and 8% of a small one is a
 * ribbon, and the conversation has a size below which it stops being readable at all: the words
 * begin breaking one per line.
 *
 * These are enforced by *redistribution*, not by overflow — see `fitTree`. Dragging a splitter into
 * the conversation's floor pushes the squeeze onward to whatever is on its other side, so the row
 * always adds up to the row. An earlier version let the pane grow past its box instead, which is
 * how a panel ended up with a slice of the conversation hidden underneath it.
 */
export const CONVERSATION_MIN_WIDTH_PX = 420;
/** Vertically: a title bar, the composer, and something between them. */
const CONVERSATION_MIN_HEIGHT_PX = 260;
/**
 * A panel's floor: smaller than the conversation's, so panels give way first — but not small
 * enough to be useless.
 *
 * 300 is what the old side panel used, and it is about the width at which a terminal stops
 * wrapping its own prompt and a file tree stops truncating every name. 180 was tried and was
 * plainly too narrow: at that size a shell wraps `Using Node v24.18.0` onto two lines.
 *
 * The height is a title bar plus enough content to be worth having opened.
 */
export const PANEL_MIN_WIDTH_PX = 300;
export const PANEL_MIN_HEIGHT_PX = 150;

/**
 * How small each kind may be drawn.
 *
 * The conversation's floor being much larger than a panel's is what decides who gives way:
 * squeezing a row pushes the panels down to their floors before the conversation moves at all.
 */
export const paneFloor = (kind: PaneKind): { width: number; height: number } =>
	kind === "conversation"
		? { width: CONVERSATION_MIN_WIDTH_PX, height: CONVERSATION_MIN_HEIGHT_PX }
		: { width: PANEL_MIN_WIDTH_PX, height: PANEL_MIN_HEIGHT_PX };

/** Floating-point slack. Shares are compared, added and re-normalised constantly. */
export const EPSILON = 1e-6;

/**
 * CSS min-width for a docked pane, or none.
 *
 * The floor is only painted when the *box* is narrower than the dock. That is the overlap
 * case: the pane draws at its floor and the neighbour covers the overhang. A pane that
 * already fills the dock — alone, or full-screen — has to shrink with the window. Otherwise
 * a 380px window draws a 420px conversation off the right edge, with nothing covering it.
 */
export function panePaintMinWidth(kind: PaneKind, boxWidth: number, maximized: boolean): number | undefined {
	if (maximized || boxWidth >= 1 - EPSILON) return undefined;
	return paneFloor(kind).width;
}

/**
 * The pane title bar, which is also the window's top row.
 *
 * The traffic lights' centre line is at y=22, and a pane in the
 * top row has to put its own title on that same line or the window reads as two misaligned strips.
 * There is no separate toolbar above the dock any more — the top row *is* the first row of panes,
 * so this number belongs to both.
 */
export { WINDOW_HEADER_HEIGHT as HEADER_HEIGHT } from "../../../shared/window-chrome.ts";

/**
 * The gap around each pane, which is what makes them read as separate cards.
 *
 * Applied inside the pane's box rather than by shrinking the box, which keeps the tiling
 * arithmetic exact — the boxes still meet edge to edge, and the seam is each of two neighbours
 * holding back this much. Half of the 4px gap between frames; the other half on
 * the window's side is `FRAME_PAD`.
 */
export const PANE_INSET = 2;

/**
 * The workspace's own padding around its docks (`.ly-frames`), so a card stands the same 4px off
 * the window's edge and off the sidebar as it does off its neighbour. Keep in step with
 * `--ly-frame-pad` in tokens.css.
 */
export const FRAME_PAD = 2;

/**
 * Room a card at the window's corner still owes the system's controls.
 *
 * `cornerReserved` is measured from a pane flush with the window and counts the card's border; a
 * card also stands `FRAME_PAD + PANE_INSET` off the edge, which is room already left.
 */
export function cardRoom(room: number): number {
	return Math.max(0, room - FRAME_PAD - PANE_INSET);
}

/**
 * The header's own left padding, before any inset for the traffic lights.
 *
 * Named because the traffic-light inset is derived from it: the lights sit at a fixed distance
 * from the *window's* edge, and what the header needs is that distance minus everything already
 * between them — this padding and the card's border.
 */
export const HEADER_PAD = 10;

/**
 * The splitter's grab area, straddling the boundary between two panes.
 *
 * Same 9px as `ResizeHandle` uses on the sidebar, for the same reason: it is the smallest strip
 * that can be hit reliably without being a visible border.
 */
export const SPLITTER_HIT = 9;

/** Keyboard resizing, per press, as a share. Shift multiplies it. */
export const SPLITTER_STEP = 0.02;
