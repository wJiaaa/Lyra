import type { ImageContent } from "@plume/core";
import { sessionMediaUrl } from "../../../shared/session-image.ts";

/**
 * Where an image block's pixels can be fetched from: a thumbnail and the full picture.
 *
 * A block carries either `media` (parked under `session-media` when the transcript was slimmed for
 * display — every large image in a reopened conversation) or `data` (a live event, or one small
 * enough to stay inline). Reading only `data` would draw every reopened image as nothing.
 */
export function imageBlockSrc(block: ImageContent, thumb: number): { src: string; full: string } | null {
	if (block.media) return { src: sessionMediaUrl(block.media, thumb), full: sessionMediaUrl(block.media) };
	if (block.data) {
		const url = `data:${block.mimeType};base64,${block.data}`;
		return { src: url, full: url };
	}
	return null;
}
