/**
 * Whether a pane is actually on screen — not merely open.
 *
 * "Open" is a property of the tree; "on screen" is what the dock is drawing right now, and the two
 * differ in exactly the cases that matter. A pane can be in the tree and invisible because it is a
 * background tab (see `usePaneOnScreen`), or because the window is narrow enough that the dock shows
 * one pane at a time. Anything deciding whether to offer a way to reach what that pane holds has to ask this
 * question rather than "is it open".
 *
 * The one caller today is the open file's header: it drops the project tree down under the
 * filename, and doing that while the tree is sitting right there is a second copy of a list already
 * on screen. See `FileTitle`.
 */

import type { PaneKind } from "./tree.ts";

export interface DockVisibility {
	/** Every pane in the tree, whether or not it can be seen. */
	present: PaneKind[];
	/** The narrow-window form, which shows one pane at a time. */
	compact: boolean;
	/** Which one that is. Meaningless unless `compact`. */
	focused: PaneKind;
}

export function paneVisible(kind: PaneKind, dock: DockVisibility): boolean {
	if (!dock.present.includes(kind)) return false;
	// One at a time, so everything else is behind it — being in the tree says nothing here.
	if (dock.compact) return dock.focused === kind;
	return true;
}

/**
 * Is full screen on offer for this pane right now?
 *
 * The answer covers both directions — the button that enters full screen and the one that leaves it
 * are the same control, so anything that hides it hides the way back too. That is what went wrong
 * before: the header inferred it from something else, and a maximised pane could be made full
 * screen and then only closed. So the rule is stated once, here.
 */
export function canToggleMaximized(
	kind: PaneKind,
	dock: Pick<DockVisibility, "compact"> & { maximized: boolean },
): boolean {
	// The conversation is already what the dock is showing; filling the window with it does nothing.
	if (kind === "conversation") return false;
	/*
	 * Not in the collapsed layout, where one pane is all there is room for — unless something is
	 * already maximised, because a window dragged narrow while full screen is on must still offer
	 * the way out.
	 */
	return !dock.compact || dock.maximized;
}
