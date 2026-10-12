/**
 * Load a generated page once, out of sight, and say what went wrong with it.
 *
 * The model writes a page it will never see. When its script throws, the card in the conversation
 * is simply empty, and the model has already said "here it is" — the reader is the one who finds
 * out. Loading the page here first turns that into a tool result the model can act on: the errors
 * the page raised, and whether it is taller than the conversation will show.
 *
 * An offscreen window, not a hidden one: a hidden window is throttled, and a page whose drawing
 * waits on a frame never runs the code that would have thrown.
 */

import type { PreviewInspection } from "@plume/core";
import { BrowserWindow, ipcMain, type NativeImage } from "electron";
import { PREVIEW_CHECK_MAX_HEIGHT, PREVIEW_CHECK_WIDTH, PREVIEW_MAX_HEIGHT, previewFragment, type PreviewTheme } from "../shared/preview.ts";
import { INSPECT_PARTITION, MEASURE_HEIGHT } from "./preview-protocol.ts";

/** Long enough for a CDN script and a first render; a page that is still loading after this is reported as it stands. */
const LOAD_BUDGET_MS = 6000;
/** After load, for the errors a page raises from its first timers and frames. */
const SETTLE_MS = 700;
const MAX_MESSAGE = 300;

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/*
 * The theme a card would hand the page, as the renderer last worked it out.
 *
 * The values are read off the renderer's document (`previewTheme`); a second derivation here would
 * be a second formula. Without it a themed page is checked unstyled — its `var(--background)` and
 * `var(--foreground)` resolve to nothing, and the screenshot shows a page the reader never sees.
 */
let theme: PreviewTheme | null = null;

export function registerPreviewThemeIpc(): void {
	ipcMain.on("preview:theme", (_event, next: unknown) => {
		const candidate = next as PreviewTheme | null;
		if (candidate && (candidate.scheme === "light" || candidate.scheme === "dark") && candidate.vars && typeof candidate.vars === "object") theme = candidate;
	});
}

/** `index.html:12` rather than the whole `ly-preview://…` address: the model knows the file by that name. */
function where(sourceId: string, line: number): string {
	if (!sourceId) return "";
	const file = sourceId.split(/[?#]/, 1)[0].split("/").pop() || sourceId;
	return line > 0 ? ` (${file}:${line})` : ` (${file})`;
}

export async function inspectPreview(
	preview: { sessionId: string; id: string; entry: string; themed?: boolean },
	options: { screenshot?: boolean; width?: number; from?: number } = {},
): Promise<PreviewInspection | null> {
	const width = options.width ?? PREVIEW_CHECK_WIDTH;
	// Loaded the way the card loads it: inline, and with the theme when the page was written for one.
	const fragment = previewFragment({ inline: true, ...(preview.themed && theme ? { theme } : {}) });
	const url = `ly-preview://${preview.sessionId}/${preview.id}/${preview.entry.split("/").map(encodeURIComponent).join("/")}${fragment}`;
	const window = new BrowserWindow({
		show: false,
		width,
		height: PREVIEW_MAX_HEIGHT,
		useContentSize: true,
		webPreferences: {
			partition: INSPECT_PARTITION,
			offscreen: true,
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
			// An `alert()` on load would otherwise raise a real dialog from a window nobody can see.
			disableDialogs: true,
			backgroundThrottling: false,
			spellcheck: false,
		},
	});
	const contents = window.webContents;
	/*
	 * Frames, not `capturePage`: an offscreen window has nothing on screen to capture, and
	 * `capturePage` comes back empty. Every frame it paints arrives here whole instead.
	 */
	let frame: NativeImage | null = null;
	if (options.screenshot) contents.on("paint", (_event, _dirty, image) => (frame = image));
	const exceptions: string[] = [];
	const errors: string[] = [];
	try {
		contents.setAudioMuted(true);
		contents.setWindowOpenHandler(() => ({ action: "deny" }));
		// The page under test stays the page under test; a redirect on load would be checking something else.
		contents.on("will-navigate", (event) => event.preventDefault());
		contents.on("console-message", (event) => {
			if (event.level !== "error") return;
			const message = event.message.length > MAX_MESSAGE ? `${event.message.slice(0, MAX_MESSAGE)}…` : event.message;
			// Chromium reports an uncaught exception as a console error that begins this way, and nothing else does.
			(event.message.startsWith("Uncaught") ? exceptions : errors).push(`${message}${where(event.sourceId, event.lineNumber)}`);
		});
		await Promise.race([contents.loadURL(url).catch(() => {}), pause(LOAD_BUDGET_MS)]);
		await pause(SETTLE_MS);
		const height = await contents
			// The card's own measure, and its pixel of slack: the number the card would size itself to.
			.executeJavaScript(`Math.ceil((${MEASURE_HEIGHT})()) + 2`, true)
			.then((value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined))
			.catch(() => undefined);
		const shot = options.screenshot
			? await capture(window, width, height, options.from ?? 0, () => frame, () => {
					frame = null;
				})
			: undefined;
		return {
			exceptions,
			errors,
			...(height === undefined ? {} : { height, limit: PREVIEW_MAX_HEIGHT }),
			...(shot ? { screenshot: shot.image, shotHeight: shot.height, ...(shot.top > 0 ? { shotTop: shot.top } : {}) } : {}),
			// 默认宽度也报：模型不知道对话多宽，就会自己猜一个再多查几次。
			width,
		};
	} catch {
		return exceptions.length + errors.length > 0 ? { exceptions, errors } : null;
	} finally {
		window.destroy();
	}
}

/**
 * The page at the width it was loaded at, from `from` down by at most `PREVIEW_CHECK_MAX_HEIGHT`.
 *
 * Scrolled after the resize, not before: the window starts at `PREVIEW_MAX_HEIGHT`, and a scroll into
 * the last, shorter stretch is clamped at that height and stays clamped once the window shrinks to
 * fit. Inline pages carry `overflow:hidden`, which stops the reader scrolling but not `scrollTo`.
 */
async function capture(
	window: BrowserWindow,
	width: number,
	height: number | undefined,
	from: number,
	latest: () => NativeImage | null,
	reset: () => void,
): Promise<{ image: { data: string; mimeType: string }; height: number; top: number } | undefined> {
	try {
		const start = height === undefined ? 0 : Math.max(0, Math.min(from, height - 1));
		const tall = Math.min(Math.max((height ?? PREVIEW_MAX_HEIGHT) - start, 1), PREVIEW_CHECK_MAX_HEIGHT);
		window.setContentSize(width, tall);
		const top = start === 0 ? 0 : await window.webContents
			.executeJavaScript(`window.scrollTo(0, ${start}); Math.round(window.scrollY)`, true)
			.then((value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0));
		// A frame painted before the scroll can already have the new size.
		if (top > 0) reset();
		window.webContents.invalidate();
		/*
		 * Wait for a frame of the new size. "A frame after the resize" is not enough: the resize lands
		 * a beat later, and a frame painted in between is still the old, taller window. Compared by
		 * proportion, since the frame is in device pixels.
		 */
		const fits = (image: NativeImage) => {
			const size = image.getSize();
			return size.width > 0 && Math.abs((size.height * width) / size.width - tall) <= 2;
		};
		let shot = latest();
		for (let waited = 0; !(shot && fits(shot)) && waited < 2000; waited += 50) {
			await pause(50);
			shot = latest();
		}
		/*
		 * A scroll into the last stretch stops short of `from` — the page cannot scroll past its own end,
		 * and `height` carries the card's pixel of slack. Then this shot does reach the bottom, and saying
		 * it ends 2px early would send the model after a stretch that is not there.
		 */
		const reach = height !== undefined && top < start ? height - top : tall;
		return shot && fits(shot) ? { image: { data: shot.toPNG().toString("base64"), mimeType: "image/png" }, height: reach, top } : undefined;
	} catch {
		return undefined;
	}
}
