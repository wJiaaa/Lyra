import type { UserContent } from "@plume/core";

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
/** 手机发前已把长边缩到 1568、压成 JPEG，一张几百 KB；这里的上限挡失控的请求，不卡正常照片。 */
const MAX_IMAGES = 4;
const MAX_IMAGE_CHARS = 5 * 1024 * 1024;

/** 一条手机消息：字和图至少有一样。图片只收模型认得的几种格式，别的一律当坏请求。 */
export function promptBlocks(rawText: unknown, rawImages: unknown = []): UserContent[] {
	if (typeof rawText !== "string" || rawText.length > 256 * 1024 || !Array.isArray(rawImages) || rawImages.length > MAX_IMAGES) throw new Error("Invalid input");
	const images = rawImages.map((image: unknown): UserContent => {
		const { data, mimeType } = (image ?? {}) as { data?: unknown; mimeType?: unknown };
		if (typeof data !== "string" || !data || data.length > MAX_IMAGE_CHARS || typeof mimeType !== "string" || !IMAGE_TYPES.has(mimeType)) throw new Error("Invalid input");
		return { type: "image", data, mimeType };
	});
	const body = rawText.trim();
	if (!body && !images.length) throw new Error("Invalid input");
	return body ? [{ type: "text", text: body }, ...images] : images;
}
