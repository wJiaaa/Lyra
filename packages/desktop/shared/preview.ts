/**
 * What a generated page and the app say to each other across the sandbox.
 *
 * The page runs on its own origin with no same-origin access, so `postMessage` and the URL fragment
 * are the only ways through, in either direction. The main process writes the page's half (the
 * script it injects, `preview-protocol.ts`) and the renderer writes the other (`PreviewCard`); the
 * names live here so the two halves cannot drift apart — a renamed key on one side is a feature
 * that silently stops working, with no error anywhere.
 */

/** The tallest a page is drawn in the conversation before it is folded; the reader can open the rest in place. */
export const PREVIEW_MAX_HEIGHT = 720;

/** The width a page is checked at before the model is told whether it fits: the default reply column. */
export const PREVIEW_CHECK_WIDTH = 720;

/**
 * How far down a check's screenshot goes. The whole page, since the reader can open it whole — a check
 * that showed the first 720px sent a model off to write the middle and the end as pages of their own
 * and check those, one call each. Bounded, because an image is paid for by its area.
 */
export const PREVIEW_CHECK_MAX_HEIGHT = 2160;

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
/** Page → app: the reader pressed something in the page that speaks for them — see `readSendRequest`. */
export const SEND_MESSAGE = "__lyPreviewSend";
/** Page → app: what the page saved for itself (`plume.setState`), as JSON text. */
export const STATE_MESSAGE = "__lyPreviewState";
/** App → page: the theme changed. */
export const THEME_MESSAGE = "__lyPreviewTheme";

/**
 * What a themed page starts from: the reply's own type, on no background of its own — the card is
 * transparent, so a page that paints nothing sits on the conversation itself. The page served by the
 * main process and the draft drawn while it is written (`PreviewDraft`) both start here.
 */
export const PREVIEW_THEMED_BASE =
	"html{color:var(--foreground);font-family:var(--font-sans);font-size:var(--font-size,14px);line-height:1.5;-webkit-font-smoothing:antialiased;text-size-adjust:100%}" +
	"body{margin:0}code,kbd,pre,samp{font-family:var(--font-mono)}";

/** Fragment keys. `ly-inline` says the page is in the conversation rather than the panel. */
export const INLINE_KEY = "ly-inline";
export const THEME_KEY = "ly-theme";
/** What the page saved last time, handed back before its scripts run as `plume.state`. */
export const STATE_KEY = "ly-state";

export interface PreviewTheme {
	scheme: "dark" | "light";
	/** Custom property name → value, every name starting with `--`. */
	vars: Record<string, string>;
}

/**
 * The fragment a page is loaded with. A fragment rather than a query, so the request — and the
 * file served — is the same however the page is being shown.
 */
export function previewFragment(options: { inline?: boolean; theme?: PreviewTheme; state?: unknown }): string {
	const parts: string[] = [];
	if (options.inline) parts.push(INLINE_KEY);
	if (options.theme) parts.push(`${THEME_KEY}=${encodeURIComponent(JSON.stringify(options.theme))}`);
	if (options.state !== undefined && options.state !== null) parts.push(`${STATE_KEY}=${encodeURIComponent(JSON.stringify(options.state))}`);
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

/** As much as a page may keep, serialized. More than a reader's choices; less than a document pasted into the next message. */
export const MAX_PAGE_STATE = 16 * 1024;

/** Longer than anything a button says for someone; a page sending more is not sending a choice. */
const MAX_SEND_LENGTH = 2000;

/**
 * What a page asked to say to the agent for the reader (`plume.send` in the page), when it is a
 * message at all: text, not blank, not a document.
 */
export function readSendRequest(data: unknown): string | null {
	if (typeof data !== "object" || data === null) return null;
	const text = (data as Record<string, unknown>)[SEND_MESSAGE];
	if (typeof text !== "string") return null;
	const trimmed = text.trim();
	return trimmed && trimmed.length <= MAX_SEND_LENGTH ? trimmed : null;
}

/** The JSON a page asked to keep (`plume.setState`), when it is text at all — `page-state.ts` decides whether it is kept. */
export function readStateRequest(data: unknown): string | null {
	if (typeof data !== "object" || data === null) return null;
	const json = (data as Record<string, unknown>)[STATE_MESSAGE];
	return typeof json === "string" ? json : null;
}

/** Page → app: every design control the page offers (`plume.tweak`), whole, each time one is added. */
export const TWEAKS_MESSAGE = "__lyPreviewTweaks";
/** App → page: controls set to values, `[{ id, value }]`, applied together and redrawn once. */
export const TWEAK_SET_MESSAGE = "__lyPreviewTweakSet";
/** Per page, per group, per select. A panel past this is a settings page, not a few things to try. */
export const MAX_TWEAK_GROUPS = 12;
export const MAX_TWEAK_CONTROLS = 12;
const MAX_TWEAK_OPTIONS = 12;

export type TweakValue = number | string | boolean;
export type TweakControl = { id: string; label: string; value: TweakValue } & (
	| { kind: "slider"; min: number; max: number; step: number; unit: string }
	| { kind: "color" }
	| { kind: "toggle" }
	| { kind: "select"; options: { label: string; value: string }[] }
);
export interface TweakGroup {
	label: string;
	controls: TweakControl[];
}

const HEX = /^#[0-9a-f]{6}$/i;
const short = (value: unknown, fallback = "") => (typeof value === "string" || typeof value === "number" ? String(value).slice(0, 80) : fallback);

/**
 * A value a control can take, or null: a number inside a slider's range and on its steps, a six-digit
 * hex colour, a boolean, one of a select's options. Both for what the page reports and for what the
 * panel is about to send it — the page wrote this control, and the reader may be any input at all.
 */
export function tweakValue(control: TweakControl, value: unknown): TweakValue | null {
	switch (control.kind) {
		case "slider": {
			if (typeof value !== "number" || !Number.isFinite(value)) return null;
			const stepped = control.min + Math.round((value - control.min) / control.step) * control.step;
			return Math.min(control.max, Math.max(control.min, Number(stepped.toFixed(6))));
		}
		case "color":
			return typeof value === "string" && HEX.test(value) ? value.toLowerCase() : null;
		case "toggle":
			return typeof value === "boolean" ? value : null;
		case "select":
			return typeof value === "string" && control.options.some((option) => option.value === value) ? value : null;
	}
}

function readControl(raw: unknown): TweakControl | null {
	if (typeof raw !== "object" || raw === null) return null;
	const record = raw as Record<string, unknown>;
	if (typeof record.id !== "string") return null;
	const base = { id: record.id, label: short(record.label, record.id), value: false as TweakValue };
	let control: TweakControl;
	if (record.kind === "slider") {
		const min = Number(record.min ?? 0), max = Number(record.max ?? 100), step = Number(record.step ?? 1);
		if (![min, max, step].every(Number.isFinite) || max <= min || step <= 0) return null;
		control = { ...base, kind: "slider", min, max, step, unit: short(record.unit) };
	} else if (record.kind === "color" || record.kind === "toggle") control = { ...base, kind: record.kind };
	else if (record.kind === "select" && Array.isArray(record.options)) {
		const options = record.options.slice(0, MAX_TWEAK_OPTIONS).map((option: unknown) => {
			const item = typeof option === "object" && option !== null ? (option as Record<string, unknown>) : { value: option };
			return { label: short(item.label ?? item.value), value: short(item.value) };
		});
		if (!options.length) return null;
		control = { ...base, kind: "select", options };
	} else return null;
	const value = tweakValue(control, record.value);
	return value === null ? null : { ...control, value };
}

/** The controls a page offered, cleaned: unknown kinds, broken ranges and values out of range are left out. */
export function readTweaks(data: unknown): TweakGroup[] | null {
	if (typeof data !== "object" || data === null) return null;
	const raw = (data as Record<string, unknown>)[TWEAKS_MESSAGE];
	if (!Array.isArray(raw)) return null;
	return raw.slice(0, MAX_TWEAK_GROUPS).flatMap((group: unknown) => {
		if (typeof group !== "object" || group === null) return [];
		const record = group as Record<string, unknown>;
		const controls = (Array.isArray(record.controls) ? record.controls : []).slice(0, MAX_TWEAK_CONTROLS).map(readControl).filter((control): control is TweakControl => control !== null);
		return controls.length ? [{ label: short(record.label), controls }] : [];
	});
}
