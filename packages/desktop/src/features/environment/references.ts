/**
 * 一个会话里出现过哪些图片和文件——环境卡片「引用」那一节的数据。
 *
 * 只从转录里汇总，不另存。收哪些是定过的：
 *
 * - 人放进来的：粘贴、拖进来的图片和文件（`attachments` 配上 image 块），@ 引用的文件；
 * - agent 产出的：`generate_image` 生成的图，`write` **新建**的文件（`details.created`）。
 *
 * 不收的同样是定过的：改过的已有文件（输入框上方的变更栏里已经有）；读过的文件和预览截图
 * （一个长会话能有上百个，全是噪音）；命令产出的文件——命令前后的对比只记仓库里 2MB 以内的文本，
 * 图片、压缩包和项目外的都抓不到，抓一半比不抓更让人困惑。
 *
 * 每一条记着它在哪一轮：`turn` 是第几问（从 1 起，给人看），`index` 是那一问在
 * `intact(messages)` 里的下标，和问题导航用的是同一个数，跳回去靠它。
 */

import type { ImageContent, Message } from "@plume/core";
import { findMentionRanges, sentKind } from "../composer/index.ts";
import { isNudge, readable } from "../../lib/spoken.ts";
import { baseName } from "../../lib/paths.ts";

export interface ImageReference {
	key: string;
	/** 画缩略图用的那一份块；没有块的（只有路径的老附件、生成图）用 `path`。 */
	block?: ImageContent;
	path?: string;
	name: string;
	turn: number;
	index: number;
}

interface FileReference {
	key: string;
	/** 记下来的样子：附件是绝对路径，@ 引用和 `write` 的可能相对于会话的目录。 */
	path: string;
	name: string;
	turn: number;
	index: number;
}

export interface References {
	images: ImageReference[];
	files: FileReference[];
}

const EMPTY: References = { images: [], files: [] };

export function referencesIn(messages: readonly Message[]): References {
	const images: ImageReference[] = [];
	const files: FileReference[] = [];
	const seenFiles = new Set<string>();
	const seenImages = new Set<string>();
	// 新建文件的 `write` 调用：参数里的路径在 assistant 那条，`created` 在结果那条，按 id 配。
	const writes = new Map<string, string>();
	let turn = 0;
	let index = -1;

	const addFile = (path: string, key: string) => {
		// 同一份文件被提到好几次，只记第一次出现的那一轮。
		if (seenFiles.has(path)) return;
		seenFiles.add(path);
		files.push({ key, path, name: baseName(path), turn, index });
	};
	const addImage = (image: Omit<ImageReference, "turn" | "index">, identity: string) => {
		if (seenImages.has(identity)) return;
		seenImages.add(identity);
		images.push({ ...image, turn, index });
	};

	for (const [at, message] of messages.entries()) {
		if (!readable(message)) continue;
		if (message.role === "user") {
			// 和问题导航同一条判断：`synthetic` 和续跑提示都挂在 user 名下，却不是人说的一问。
			if (message.synthetic || isNudge(message)) continue;
			turn += 1;
			index = at;
			userReferences(message, at, addImage, addFile);
			continue;
		}
		// 第一问之前没有轮可归，agent 也不会在那之前产出东西。
		if (turn === 0) continue;
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type !== "toolCall" || block.name !== "write") continue;
				const path = block.arguments.path;
				if (typeof path === "string" && path) writes.set(block.id, path);
			}
			continue;
		}
		if (message.isError) continue;
		const details = message.details as Record<string, unknown> | undefined;
		if (message.toolName === "generate_image") {
			const paths = Array.isArray(details?.paths) ? details.paths.filter((path): path is string => typeof path === "string") : [];
			const blocks = message.content.filter((block): block is ImageContent => block.type === "image");
			const count = Math.max(paths.length, blocks.length);
			for (let n = 0; n < count; n++) {
				const path = paths[n];
				addImage({ key: `gen-${at}-${n}`, ...(blocks[n] ? { block: blocks[n] } : {}), ...(path ? { path } : {}), name: path ? baseName(path) : "" }, path ?? `gen-${at}-${n}`);
			}
			continue;
		}
		if (message.toolName === "write" && details?.created === true) {
			const path = writes.get(message.toolCallId);
			if (path) addFile(path, `write-${at}`);
		}
	}
	return images.length || files.length ? { images, files } : EMPTY;
}

function userReferences(
	message: Extract<Message, { role: "user" }>,
	at: number,
	addImage: (image: Omit<ImageReference, "turn" | "index">, identity: string) => void,
	addFile: (path: string, key: string) => void,
): void {
	const blocks = message.content.filter((block): block is ImageContent => block.type === "image");
	let used = 0;
	// 和气泡外那一排同一个配法（`UserMessage` 的 `attachmentsOf`）：第 n 个图片门类的附件配第 n 个图片块。
	for (const [n, file] of (message.attachments ?? []).entries()) {
		if (!file || typeof file !== "object") continue;
		const kind = sentKind(file);
		if (kind === "image") {
			const block = blocks[used];
			if (block) used++;
			if (!block && !file.path) continue;
			addImage({ key: `att-${at}-${n}`, ...(block ? { block } : {}), ...(file.path ? { path: file.path } : {}), name: file.name }, file.path ?? `att-${at}-${n}`);
			continue;
		}
		// 文件夹不算：这一节回答的是「那份东西」，一个目录点开是整棵树，那是文件面板的事。
		if (kind === "folder" || !file.path) continue;
		addFile(file.path, `att-${at}-${n}`);
	}
	// 配不上附件的图片块是老消息或粘贴进来的图，一样是人放进来的。
	for (; used < blocks.length; used++) addImage({ key: `img-${at}-${used}`, block: blocks[used], name: "" }, `img-${at}-${used}`);

	/*
	 * @ 引用只认带引号的那种。
	 *
	 * 文件提及一律由 `formatMention` 写成 `@"路径"`；不带引号的 `@名字` 是子智能体，或者人随手打的
	 * `@types/node`、邮箱——把它们当文件，列出来的就是一份不存在的文件。以 `/` 结尾的是目录。
	 */
	const text = message.displayText ?? message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
	for (const range of findMentionRanges(text)) {
		if (!range.text.startsWith("@\"") || !range.inner || range.inner.endsWith("/")) continue;
		addFile(range.inner, `at-${at}-${range.start}`);
	}
}
