import { useEffect, useRef, useState, type RefObject } from "react";
import { bridge } from "../../services/index.ts";
import { useApp } from "../../store/index.ts";
import { translate } from "../../i18n/translate.ts";

/** How long the tick stays: long enough to be seen, short of reading as stuck. As `CopyMark`. */
const CONFIRM_MS = 1400;
/**
 * After the frame is stretched to the whole page: the page lives in another process, and its first
 * frame at the new size arrives some frames after this document's — taken sooner, the bottom of the
 * first slice was the old, shorter page.
 */
const RELAYOUT_MS = 120;
/** The tallest a canvas may be, in device pixels; past it Chromium hands back an empty picture. */
const MAX_CANVAS = 32767;

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The part of `element` a reader can actually see: cut to every ancestor that clips it, and to whole
 * pixels so slices taken from it meet without a seam.
 *
 * A card half scrolled out of the transcript is drawn under the title bar or the composer there, and
 * a capture of its whole rectangle would be a picture of those.
 */
function visibleRect(element: HTMLElement): DOMRect | null {
	let { left, top, right, bottom } = element.getBoundingClientRect();
	for (let node = element.parentElement; node; node = node.parentElement) {
		if (getComputedStyle(node).overflow === "visible") continue;
		const clip = node.getBoundingClientRect();
		left = Math.max(left, clip.left);
		top = Math.max(top, clip.top);
		right = Math.min(right, clip.right);
		bottom = Math.min(bottom, clip.bottom);
	}
	left = Math.ceil(left);
	top = Math.ceil(top);
	right = Math.floor(Math.min(right, window.innerWidth));
	bottom = Math.floor(Math.min(bottom, window.innerHeight));
	return right - left >= 1 && bottom - top >= 1 ? new DOMRect(left, top, right - left, bottom - top) : null;
}

/**
 * Lift the soft edges of every scroller around `element` until the returned undo runs. A slice taken
 * under the transcript's fade (`scroll.css`) is that slice half gone, and with the page moved through
 * the card every slice can land there.
 */
function unmask(element: HTMLElement): () => void {
	const undo: (() => void)[] = [];
	for (let node = element.parentElement; node; node = node.parentElement) {
		const style = getComputedStyle(node);
		if (style.maskImage === "none" && style.webkitMaskImage === "none") continue;
		const { maskImage, webkitMaskImage } = node.style;
		node.style.maskImage = "none";
		node.style.webkitMaskImage = "none";
		const target = node;
		undo.push(() => {
			target.style.maskImage = maskImage;
			target.style.webkitMaskImage = webkitMaskImage;
		});
	}
	return () => {
		for (const step of undo) step();
	};
}

function load(src: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const image = new Image();
		image.onload = () => resolve(image);
		image.onerror = reject;
		image.src = src;
	});
}

/**
 * A page on the clipboard as a picture, the way it looks now — after whatever the reader did in it —
 * and all of it, not just the part the card shows.
 *
 * Taken from the window rather than by loading the page again out of sight (`preview-inspect.ts`):
 * a fresh load is the page before anyone touched it, and what a reader copies is the state they got
 * it into. The window only has what is on screen, so the frame is stretched to the page's own height
 * (`whole`, what the page last asked for) and moved up through the visible part of the card a slice
 * at a time; the card itself keeps its size, so the transcript does not move. Neither change reloads
 * the page. The card's own buttons are hidden for the while (`capturing`); they are not part of the page.
 */
export function usePreviewCopy(frame: RefObject<HTMLIFrameElement | null>, whole: RefObject<number>) {
	const [capturing, setCapturing] = useState(false);
	const [copied, setCopied] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);

	async function slices(element: HTMLIFrameElement): Promise<string | null> {
		const box = element.getBoundingClientRect();
		const view = visibleRect(element);
		if (!view) return null;
		const height = Math.min(Math.max(Math.round(box.height), Math.ceil(whole.current)), Math.floor(MAX_CANVAS / devicePixelRatio));
		if (height > box.height) {
			element.style.height = `${height}px`;
			await pause(RELAYOUT_MS);
		}
		const shots: string[] = [];
		for (let y = 0; y < height; y += view.height) {
			// Row `y` of the page at the top of what can be seen.
			element.style.transform = `translateY(${view.top - box.top - y}px)`;
			// One frame for the move, one for the compositor to have drawn it.
			await nextFrame();
			await nextFrame();
			const shot = await bridge.windows.capture({ x: view.x, y: view.y, width: view.width, height: Math.min(view.height, height - y) });
			if (!shot) return null;
			shots.push(shot);
		}
		if (shots.length === 1) return shots[0];
		const images = await Promise.all(shots.map(load));
		// Device pixels per CSS pixel, from what came back rather than assumed.
		const scale = images[0].naturalWidth / view.width;
		const canvas = document.createElement("canvas");
		canvas.width = images[0].naturalWidth;
		canvas.height = Math.round(height * scale);
		const context = canvas.getContext("2d");
		if (!context) return null;
		images.forEach((image, index) => context.drawImage(image, 0, Math.round(index * view.height * scale)));
		return canvas.toDataURL("image/png");
	}

	async function copy() {
		const element = frame.current;
		if (!element || capturing) return;
		setCapturing(true);
		const restore = unmask(element);
		let image: string | null = null;
		try {
			// One frame for React to hide the buttons, one for the compositor to have painted without them.
			await nextFrame();
			await nextFrame();
			image = await slices(element);
		} catch {
			image = null;
		} finally {
			element.style.height = "";
			element.style.transform = "";
			restore();
			setCapturing(false);
		}
		const done = image !== null && (await bridge.clipboard.writeImage(image).catch(() => false));
		if (!done) {
			useApp.getState().notify(translate("preview.copyFailed"), "warn");
			return;
		}
		setCopied(true);
		clearTimeout(timer.current);
		timer.current = setTimeout(() => setCopied(false), CONFIRM_MS);
	}

	return { capturing, copied, copy };
}
