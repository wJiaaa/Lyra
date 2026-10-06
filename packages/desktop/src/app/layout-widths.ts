/**
 * How wide the sidebar may be, and what it was last time.
 *
 * Remembered across launches because a width is a preference, not a state — someone who widened
 * the sidebar to read long session titles meant it for next time too. Clamped on the way back in,
 * since a stored width from a larger display would otherwise leave no room for anything else.
 */

export const SIDEBAR_DEFAULT = 272;
/**
 * Narrow enough to be worth dragging to, wide enough for the sidebar's rows.
 *
 * It was measured off the 项目/聊天 strip (216px in Chinese plus 10px of padding either side). The
 * strip is gone and nothing that is left needs that much, so this is now a floor that was kept
 * rather than one that is forced: lowering it is safe as long as the title row and a session row's
 * trailing time still fit.
 */
export const SIDEBAR_MIN = 240;
/** Past this the sidebar is wider than the thing it navigates, which is not a use. */
export const SIDEBAR_MAX = 420;

/*
 * The right-hand panel's widths used to live here too. The dock divides itself in shares and
 * remembers them per project, so there is no one width left to store — what replaced them is
 * `CONVERSATION_MIN_WIDTH_PX` and `PANEL_MIN_WIDTH_PX` in `dock/geometry.ts`, which are floors on
 * how small a pane may be *drawn* rather than a width anything is set to.
 */

export function storedWidth(key: string, fallback: number, min: number, max: number): number {
	const raw = Number(window.localStorage.getItem(key));
	return Number.isFinite(raw) && raw > 0 ? Math.min(max, Math.max(min, raw)) : fallback;
}
