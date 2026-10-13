import type { Message, UserContent, UserMessage } from "@plume/core";
import { isAttachmentBody } from "./attachment-placeholders.ts";

type RestoredAttachment = {
	id: string;
	name: string;
	mimeType: string;
	kind?: string;
	data?: string;
	/** 像素已经挪进 `session-media` 时的文件名；装回输入框前由 `withParkedPixels` 读回来。 */
	media?: string;
	text?: string;
	isText: boolean;
	path?: string;
	label?: string;
	/** 撤回的标注副本仍然记得它是从哪张图上标的（`ImageContent.from`）。 */
	markedFrom?: string;
};

export type RestoredDraft = {
	text: string;
	attachments: RestoredAttachment[];
	sessionRefs: Array<{ id: string; title: string }>;
};

type ImageBlock = Extract<UserContent, { type: "image" }>;
type TextBlock = Extract<UserContent, { type: "text" }>;

/** Last real user turn, ignoring the synthetic 「继续」 notes that never appear as a bubble. */
export function lastUserMessageIndex(messages: Message[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "user" && !message.synthetic) return i;
	}
	return -1;
}

/**
 * 一张图的像素，或者像素所在的文件名。
 *
 * 会话日志把大图挪进 `session-media`，块里只剩 `media` 名字、`data` 是空串——真实照片几乎都超过
 * 内联上限。只拷 `data` 的话，撤回、分叉后再发出去的就是一行「contents not included」，模型根本
 * 没看到那张图。
 */
export function pixelsOf(image: ImageBlock): { data?: string; media?: string } {
	if (image.data) return { data: image.data };
	return image.media ? { media: image.media } : {};
}

function bodyText(block: string): string | undefined {
	return block.match(/```\n([\s\S]*?)\n```/)?.[1];
}

/**
 * What the composer should hold after this user message is taken back.
 *
 * Images come from the content blocks (pixels live there). Paths and labels come from
 * `attachments`. Typed words prefer `displayText` so a file body does not land in the field.
 */
export function draftFromUserMessage(message: UserMessage): RestoredDraft {
	const images = message.content.filter((block): block is ImageBlock => block.type === "image");
	const bodies = message.content.filter((block): block is TextBlock => block.type === "text" && isAttachmentBody(block.text));
	const spoken = message.content
		.filter((block): block is TextBlock => block.type === "text" && !isAttachmentBody(block.text))
		.map((block) => block.text)
		.join("\n");
	let imageAt = 0;
	let bodyAt = 0;
	const attachments: RestoredAttachment[] = [];
	for (const [index, file] of (message.attachments ?? []).entries()) {
		const kind = file.kind;
		const isImage = kind === "image" || Boolean(file.mimeType?.startsWith("image/"));
		const isText = kind === "text";
		const image = isImage ? images[imageAt++] : undefined;
		const body = isText ? bodies[bodyAt++] : undefined;
		attachments.push({
			id: `revert-${index}-${file.name}`,
			name: file.name,
			mimeType: file.mimeType ?? image?.mimeType ?? "application/octet-stream",
			isText: Boolean(isText),
			...(kind ? { kind } : {}),
			...(image ? pixelsOf(image) : {}),
			...(body ? { text: bodyText(body.text) } : {}),
			...(file.path ? { path: file.path } : {}),
			...(file.label ? { label: file.label } : {}),
			...(image?.from ? { markedFrom: image.from } : {}),
		});
	}
	for (; imageAt < images.length; imageAt++) {
		attachments.push({
			id: `revert-image-${imageAt}`,
			name: "",
			mimeType: images[imageAt].mimeType,
			kind: "image",
			...pixelsOf(images[imageAt]),
			isText: false,
			...(images[imageAt].from ? { markedFrom: images[imageAt].from } : {}),
		});
	}
	return {
		text: message.displayText ?? spoken,
		attachments,
		sessionRefs: message.sessionRefs ?? [],
	};
}
