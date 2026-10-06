/**
 * How much of the window's top belongs to the window's own toolbar (`--ly-chrome-top`, set by the
 * layout while there is one — see `framed` in `app/layout.tsx`). Zero in a window with no toolbar.
 *
 * Floating surfaces stop under it. They used to be kept only from the window's edge, so a preview
 * opening upwards from a row near the top of the conversation spread over the toolbar: its title,
 * its buttons and, on macOS, the strip the window is dragged by.
 */
export function chromeTop(): number {
	if (typeof document === "undefined" || !document.documentElement) return 0;
	const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ly-chrome-top"));
	return Number.isFinite(value) && value > 0 ? value : 0;
}
