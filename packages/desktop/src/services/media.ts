/**
 * 把已经挪进 `session-media` 的图片读回成 base64，装回输入框用。
 *
 * 撤回、分叉、方向键翻历史都会把一条发过的消息还原成草稿，而那条消息里的大图只剩一个文件名
 * （见 `lib/revert-draft.ts` 的 `pixelsOf`）。草稿和发送这一路认的是 `data`，所以在装回去之前把
 * 像素取回来，后面的缩略图、标注、打包都照旧，不必各自认识 `media`。
 *
 * 走 `ly-media://m/`：缩略图本来就从那里取，主进程在 `preview-protocol.ts` 里只放行那个目录。字节经
 * `files.media` 由主进程读：窗口的 origin 是 `file://`，它自己 `fetch` 这个地址会被 CORS 拒掉。
 */

import { sessionMediaUrl } from "../../shared/session-image.ts";
import { bridge } from "./bridge.ts";

export async function withParkedPixels<T extends { data?: string; media?: string }>(attachments: T[]): Promise<T[]> {
	if (!attachments.some((attachment) => !attachment.data && attachment.media)) return attachments;
	return Promise.all(
		attachments.map(async (attachment) => {
			if (attachment.data || !attachment.media) return attachment;
			const data = await parkedImageData(attachment.media);
			// 文件已经被清掉了：留着名字，发出去是一行「contents not included」，和从前一样诚实。
			return data ? { ...attachment, data } : attachment;
		}),
	);
}

async function parkedImageData(name: string): Promise<string | null> {
	try {
		const media = await bridge.files.media(sessionMediaUrl(name));
		if (!media) return null;
		const bytes = media.data;
		let binary = "";
		for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
		return btoa(binary);
	} catch {
		return null;
	}
}
