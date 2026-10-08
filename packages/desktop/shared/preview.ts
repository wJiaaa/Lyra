/**
 * What a generated page and the app say to each other across the sandbox.
 *
 * The page runs on its own origin with no same-origin access, so `postMessage` and the URL fragment
 * are the only ways through, in either direction. The main process writes the page's half (the
 * script it injects, `preview-protocol.ts`) and the renderer writes the other (`PreviewCard`); the
 * names live here so the two halves cannot drift apart — a renamed key on one side is a feature
 * that silently stops working, with no error anywhere.
 */

/** The tallest a page is drawn in the conversation; taller ones are cut off and offered the panel. */
export const PREVIEW_MAX_HEIGHT = 720;

/** The width a page is checked at before the model is told whether it fits: the default reply column. */
export const PREVIEW_CHECK_WIDTH = 720;

/** Page → app: the height the page needs. */
export const HEIGHT_MESSAGE = "__dwPreviewHeight";
/**
 * Page → app, alongside the height: the width the page was measured at. Its own, not the frame's
 * as read by the card — the message arrives a moment after the measurement, and in a resize the
 * frame has already moved on by then.
 */
export const WIDTH_KEY = "__lyPreviewWidth";
/** Page → app: the reader clicked a link that leaves the page. */
export const OPEN_MESSAGE = "__lyPreviewOpen";
/** App → page: the theme changed. */
export const THEME_MESSAGE = "__lyPreviewTheme";

/** Fragment keys. `ly-inline` says the page is in the conversation rather than the panel. */
export const INLINE_KEY = "ly-inline";
export const THEME_KEY = "ly-theme";

export interface PreviewTheme {
	scheme: "dark" | "light";
	/** Custom property name → value, every name starting with `--`. */
	vars: Record<string, string>;
}

/**
 * The fragment a page is loaded with. A fragment rather than a query, so the request — and the
 * file served — is the same however the page is being shown.
 */
export function previewFragment(options: { inline?: boolean; theme?: PreviewTheme }): string {
	const parts: string[] = [];
	if (options.inline) parts.push(INLINE_KEY);
	if (options.theme) parts.push(`${THEME_KEY}=${encodeURIComponent(JSON.stringify(options.theme))}`);
	return parts.length > 0 ? `#${parts.join("&")}` : "";
}

/**
 * The link a page asked to have opened, when it is one the app may open.
 *
 * Only addresses that go to the user's browser or mail client: anything else — `file:`, `javascript:`,
 * one of our own schemes — is the page asking the app to do something on its behalf.
 */
export function readOpenRequest(data: unknown): string | null {
	if (typeof data !== "object" || data === null) return null;
	const url = (data as Record<string, unknown>)[OPEN_MESSAGE];
	if (typeof url !== "string") return null;
	try {
		const parsed = new URL(url);
		return ["http:", "https:", "mailto:"].includes(parsed.protocol) ? parsed.href : null;
	} catch {
		return null;
	}
}
