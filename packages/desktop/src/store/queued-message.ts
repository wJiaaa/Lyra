/**
 * 排在输入框上方的一条，长什么样。
 *
 * 单独一个文件、只有类型，`queue-slice.ts` 从这里转出去。侧边聊天也是会话，排的是同一条队（按它自己的会话 id）。
 */

import type { UserContent } from "@plume/core";

/** 附件在草稿里的样子。和 `drafts` 里的同一种东西，因为「编辑」要把它原样放回去。 */
interface QueuedAttachment {
	id: string;
	name: string;
	mimeType: string;
	kind?: string;
	data?: string;
	text?: string;
	isText?: boolean;
}

/** 一次提交在输入框里本来的样子。 */
interface QueuedDraft {
	text: string;
	attachments: QueuedAttachment[];
	sessionRefs: { id: string; title: string }[];
}

export interface QueuedMessage {
	id: string;
	/** 展开好的、真正发出去的东西——命令已经变成它代表的提示词，图片已经是 content 块。 */
	content: UserContent[];
	displayText?: string;
	skillRef?: { name: string; path?: string; pluginId?: string };
	sessionRefs?: { id: string; title: string }[];
	/** 名字和门类，给气泡里那排胶囊用；正文不在里面。 */
	attachments?: { name: string; kind?: string; mimeType?: string }[];
	/** 原样收着的草稿，「编辑」拿它回填输入框。 */
	draft: QueuedDraft;
	/** 条上那一行字。展开前的原文，因为那才是人写下的话。 */
	preview: string;
	/** 第一张图，条上那个缩略图。 */
	thumbnail?: { mimeType: string; data: string };
}
