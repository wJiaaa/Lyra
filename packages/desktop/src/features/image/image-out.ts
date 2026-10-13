/**
 * A picture leaving the app: to the clipboard, to a file, into the composer.
 *
 * The viewer's buttons and the context menu on a generated image both go through here, so the two
 * cannot drift apart. Every route starts from the bytes, and for a `ly-media://` picture only the
 * main process has them — see `files.media`.
 */

import { bridge } from "../../services/index.ts";
import { translate } from "../../i18n/translate.ts";
import { useApp } from "../../store/index.ts";

/** Any picture the app can show, as a `data:` URL; null when its bytes are gone. */
export async function imageDataUrl(src: string): Promise<string | null> {
	if (src.startsWith("data:")) return src;
	const media = await bridge.files.media(src);
	if (!media) return null;
	let binary = "";
	for (let i = 0; i < media.data.length; i += 0x8000) binary += String.fromCharCode(...media.data.subarray(i, i + 0x8000));
	return `data:${media.mimeType};base64,${btoa(binary)}`;
}

/**
 * The picture, ready to paste.
 *
 * Falls back to saving a file if the clipboard refuses: for a marked-up copy, losing the annotation
 * to that would be the worst of the outcomes.
 */
export async function copyImage(src: string): Promise<void> {
	try {
		if (!(await bridge.clipboard.writeImage(await asPng(src)))) throw new Error("nothing decoded");
		useApp.getState().notify(translate("viewer.copied"));
	} catch {
		if (await saveImage(src)) useApp.getState().notify(translate("viewer.clipboardUnavailable"), "warn");
	}
}

/**
 * Said out loud when a picture could not be had.
 *
 * Every route here runs inside a click, and a failure there used to be swallowed: the button was
 * pressed and nothing happened, which reads as the app not having heard the click.
 */
export function notifyExportFailed(): void {
	useApp.getState().notify(translate("viewer.exportFailed"), "error");
}

/**
 * Save a copy where downloads go.
 *
 * Always through a `data:` URL. `download` is ignored on a cross-origin link, so an anchor straight
 * to `ly-media://` navigated the whole window to the bare picture instead of saving it.
 */
export async function saveImage(src: string): Promise<boolean> {
	const dataUrl = await imageDataUrl(src);
	if (!dataUrl) {
		notifyExportFailed();
		return false;
	}
	const subtype = /^data:image\/([\w.+-]+)/.exec(dataUrl)?.[1] ?? "png";
	const link = document.createElement("a");
	link.href = dataUrl;
	link.download = imageFileName(subtype === "jpeg" ? "jpg" : subtype);
	link.click();
	return true;
}

/** `plume-image-2026-10-13-11-58-03.png`，本地时间：存下来的图在下载文件夹里认得出是哪天的，毫秒时间戳认不出。 */
export function imageFileName(extension: string, at = new Date()): string {
	const two = (value: number) => String(value).padStart(2, "0");
	const stamp = `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}-${two(at.getHours())}-${two(at.getMinutes())}-${two(at.getSeconds())}`;
	return `plume-image-${stamp}.${extension}`;
}

/**
 * As a PNG `data:` URL.
 *
 * The clipboard's image format is PNG, and `nativeImage` decodes only PNG and JPEG — a WebP or GIF
 * attachment handed over as-is decodes to nothing. Redrawing through a canvas turns whatever the
 * window could decode into PNG; an annotated copy is already one and passes straight through.
 */
async function asPng(src: string): Promise<string> {
	const dataUrl = await imageDataUrl(src);
	if (!dataUrl) throw new Error("image is gone");
	if (dataUrl.startsWith("data:image/png")) return dataUrl;
	const bitmap = await createImageBitmap(decode(dataUrl));
	const canvas = document.createElement("canvas");
	canvas.width = bitmap.width;
	canvas.height = bitmap.height;
	canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
	bitmap.close();
	return canvas.toDataURL("image/png");
}

/**
 * A `data:` URL to a `Blob`, by hand.
 *
 * `fetch(dataUrl)` is the tidy way to do this and it does not work here: the renderer's content
 * policy rejects `data:` as a fetch target. `atob` has no such opinion. The type is left for
 * `createImageBitmap` to sniff.
 */
function decode(dataUrl: string): Blob {
	const comma = dataUrl.indexOf(",");
	const binary = atob(dataUrl.slice(comma + 1));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return new Blob([bytes]);
}
