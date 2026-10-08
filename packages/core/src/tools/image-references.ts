/**
 * `generate_image` 的参考图从哪来：本地路径，或者对话里最近的几张。
 *
 * 两条路是照着 Codex 的 `imagegen` 定的（`referenced_image_paths` / `num_last_images_to_include`）。
 * 只给路径不够：人贴进来的图在模型眼里只有像素和一个文件名，没有路径——它看得见那张图，却说不出
 * 那张图在哪。「最近的第几张」是它唯一能指住这种图的说法。
 */

import { readFile, realpath, stat } from "node:fs/promises";
import { safeMediaName, sessionMediaPath } from "../session/payload.ts";
import { SessionStore } from "../session/store.ts";
import type { ToolContext } from "../types.ts";
import { imageMimeType } from "./paths.ts";
import { authorizeRead, toAbsolute } from "./read-access.ts";

export interface ReferenceImage {
	data: string;
	mimeType: string;
}

/** OpenAI 的编辑接口一次最多收这么多张；再多也只是被端点拒掉。 */
export const MAX_REFERENCES = 5;
/** 编辑接口单张的上限比对话里看图宽，但一张二十兆的图多半是选错了文件。 */
const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;

/** 读本地路径上的图，和 `read` 走同一道读权限。出错时返回给模型看的那句话。 */
export async function referencesFromPaths(paths: string[], ctx: ToolContext): Promise<ReferenceImage[] | string> {
	const images: ReferenceImage[] = [];
	for (const path of paths) {
		let absolute: string;
		try {
			absolute = await realpath(toAbsolute(ctx.cwd, path));
		} catch {
			return `找不到参考图：${path}`;
		}
		const authorized = await authorizeRead(ctx, absolute, {});
		if (!authorized.ok) return authorized.message;
		const mimeType = imageMimeType(absolute);
		if (!mimeType) return `${path} 不是图片`;
		const info = await stat(absolute);
		if (info.size > MAX_REFERENCE_BYTES) return `${path} 有 ${(info.size / 1024 / 1024).toFixed(1)} MB，超过 ${MAX_REFERENCE_BYTES / 1024 / 1024} MB`;
		images.push({ data: (await readFile(absolute)).toString("base64"), mimeType });
	}
	return images;
}

/**
 * 对话里最近的 `count` 张图，按出现的先后排。
 *
 * 人发的消息和工具结果里的都算——前者是贴进来的图，后者是 `read` 读过的、`generate_image` 画过的。
 * 落盘的会话里大图只剩 `session-media` 里的文件名，这里从文件读回像素。
 */
export async function recentReferences(count: number, ctx: ToolContext): Promise<ReferenceImage[] | string> {
	const messages = await (ctx.transcript?.() ?? new SessionStore().messages(ctx.sessionId)).catch(() => null);
	if (!messages) return "读不到这个会话的记录，取不到对话里的图。";
	const found: ReferenceImage[] = [];
	for (let i = messages.length - 1; i >= 0 && found.length < count; i--) {
		const message = messages[i];
		if (message.role !== "user" && message.role !== "toolResult") continue;
		for (let j = message.content.length - 1; j >= 0 && found.length < count; j--) {
			const block = message.content[j];
			if (block.type !== "image") continue;
			const data = block.data || (block.media ? await parked(block.media) : null);
			if (data) found.push({ data, mimeType: block.mimeType });
		}
	}
	if (found.length < count) return `要的是对话里最近 ${count} 张图，只找到 ${found.length} 张。请用户重新附上缺的那张。`;
	return found.reverse();
}

async function parked(name: string): Promise<string | null> {
	const safe = safeMediaName(name);
	if (!safe) return null;
	const bytes = await readFile(sessionMediaPath(safe)).catch(() => null);
	return bytes ? bytes.toString("base64") : null;
}
