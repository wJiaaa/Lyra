import { useEffect, useRef, useState, type RefObject } from "react";
import { bridge } from "../../services/index.ts";
import { useApp } from "../../store/index.ts";
import { translate } from "../../i18n/translate.ts";

/** How long the tick stays: long enough to be seen, short of reading as stuck. As `CopyMark`. */
const CONFIRM_MS = 1400;

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/**
 * The part of `element` a reader can actually see: cut to every ancestor that clips it.
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
	right = Math.min(right, window.innerWidth);
	bottom = Math.min(bottom, window.innerHeight);
	return right - left >= 1 && bottom - top >= 1 ? new DOMRect(left, top, right - left, bottom - top) : null;
}

/**
 * A page on the clipboard as a picture, the way it looks now — after whatever the reader did in it.
 *
 * Taken from the window rather than by loading the page again out of sight (`preview-inspect.ts`):
 * a fresh load is the page before anyone touched it, and what a reader copies is the state they got
 * it into. The card's own buttons are hidden for the frame (`capturing`); they are not part of the page.
 */
export function usePreviewCopy(host: RefObject<HTMLElement | null>) {
	const [capturing, setCapturing] = useState(false);
	const [copied, setCopied] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);

	async function copy() {
		const element = host.current;
		if (!element || capturing) return;
		setCapturing(true);
		let done = false;
		try {
			// One frame for React to hide the buttons, one for the compositor to have painted without them.
			await nextFrame();
			await nextFrame();
			const rect = visibleRect(element);
			done = rect !== null && (await bridge.clipboard.capture({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }));
		} catch {
			done = false;
		} finally {
			setCapturing(false);
		}
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
