/**
 * 发出去的消息里带着的那些文件，右边的文件面板可以只读地打开。
 *
 * 面板的每一扇门——`files:read`、`files:bytes`、`files:document`、`ly-media`——都只认已打开项目里的
 * 路径，而附件绝大多数来自项目外：桌面、下载目录。于是一份拖进对话的 `.md`，在消息里点「预览」，面板
 * 读到的只会是一句「无法读取」。
 *
 * 放行的依据和 core 那边是同一份。`runtime/session-turn.ts` 的 `collectAllowedPaths` 早就把本机消息里
 * 记下的附件路径当成「这一轮模型可以读的工作区外文件」——人把这个文件交给了对话，模型读得，应用自己的
 * 面板反而读不得，说不过去。规则也照抄它：只认用户消息，只认绝对路径，精确到那一个文件（不含它所在的
 * 目录、不含它旁边的任何东西），只读（写那扇门不经过这里）。
 *
 * 另一类是助手回复里画成文件链接的路径（`[截图](/Users/…/a.png)`、`` `/abs/a.ts:42` ``）。验证截图、录屏
 * 照规矩放在桌面上，回复里链过去，点开却只有「读不到这个文件」。这一类 core 那边没有对应：它不让模型多读
 * 任何东西，只让人点得开模型指给他看的那一个文件——同样精确到文件、同样只读，点不点由人决定。
 *
 * 路径只从主进程自己经手的记录里来：交给窗口的转录（`slimSnapshot`）、活会话里每一条收尾的消息
 * （`session-hub.ts` 的 `broadcast`），和本机递进来、过了 `prompt-input.ts` 那道门的新消息。远端递进来的 `path` 在那道门上就被丢掉了，到不了这里；窗口随口报
 * 一个路径也换不来通行——这里没有任何一个 IPC 入口。
 *
 * 记下的只是字符串，不碰磁盘。每打开一个会话，转录就经过这里一次；要是在这时对每份附件同步解析真实
 * 路径，等于让主进程替每一个挂载点（包括睡着的网络盘）排一次队。真去读的那一刻才解析。
 */

import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { Message } from "@plume/core";

const attached = new Set<string>();

/** 记下一个本机附件的路径。不是绝对路径的不认——相对谁补全，谁也没打算授权。 */
export function noteAttachmentPath(path: unknown): void {
	if (typeof path !== "string" || path.length === 0 || !isAbsolute(path)) return;
	attached.add(resolve(path));
}

/**
 * 记下这批消息里人自己带进来的文件，和助手回复里链过去的文件。
 *
 * 转录里躺着的是没人再校验过的数据：稀疏数组的空洞、缺了 `attachments` 的老消息、形状不对的一项，
 * 都只是跳过，不抛——这是交转录给窗口的必经之路，在这里抛出去，会话就打不开了。
 */
export function noteTranscriptFiles(messages: readonly Message[]): void {
	for (const message of messages) {
		if (message?.role === "user" && Array.isArray(message.attachments)) {
			for (const attachment of message.attachments) noteAttachmentPath(attachment?.path);
		} else if (message?.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (block?.type === "text" && typeof block.text === "string") for (const path of linkedPaths(block.text)) noteAttachmentPath(path);
			}
		}
	}
}

/** 链接里 `(…)` 那一段最多扫多远；和窗口的 `URL_SPAN` 一个量级，没收口的不是链接。 */
const HREF_SPAN = 4096;

/**
 * 一段回复里会被窗口画成文件链接的绝对路径：`[…](href)` / `![…](src)` 的目标，和行内代码。
 *
 * 认法跟着 `Markdown.tsx` 的 `Link` 与 `lib/markdown/assets.ts` 的 `resolveAsset` 走——去掉 `:42` 行号、
 * `?…` `#…`，再 `decodeURI`——两边认出来的必须是同一个字符串，否则点开的那个仍然不在名单上。宁宽勿紧：
 * 多认一个只是多记一个模型自己写出来、而且非得是普通文件才放行的路径；少认一个就是一个点不开的链接。
 */
export function linkedPaths(text: string): string[] {
	const candidates: string[] = [];
	for (let at = text.indexOf("]("); at !== -1; at = text.indexOf("](", at + 2)) {
		let depth = 0;
		let end = at + 1;
		const stop = Math.min(text.length, at + 1 + HREF_SPAN);
		for (; end < stop; end++) {
			if (text[end] === "\\") end++;
			else if (text[end] === "(") depth++;
			else if (text[end] === ")" && --depth === 0) break;
		}
		if (depth !== 0) continue;
		// `[x](url "title")` 的标题不是路径的一部分。
		candidates.push(text.slice(at + 2, end).trim().replace(/\s+["'(].*$/, ""));
	}
	// 行内代码。反引号写成 \x60：字面的反引号会让 `check-i18n` 把后面的注释当成模板字符串里的文案。
	for (const match of text.matchAll(/\x60([^\x60\n]+)\x60/g)) candidates.push(match[1]);

	const paths: string[] = [];
	for (const candidate of candidates) {
		const raw = candidate.trim().replace(/:\d+(?:-\d+)?$/, "").split("#")[0].split("?")[0];
		let path: string;
		try { path = decodeURI(raw).trim(); }
		catch { continue; }
		if (path && isAbsolute(path)) paths.push(path);
	}
	return paths;
}

/**
 * 这个路径是不是某条消息带进来的文件：是的话交回它此刻的真实位置，不是就是 null。
 *
 * 只交普通文件。记下的是发送那一刻的位置，之后那里可能换成了一个目录——交出去的话，`ly-media` 会把
 * 整个目录的清单递给窗口。
 */
export async function attachmentFile(path: unknown): Promise<string | null> {
	if (typeof path !== "string" || path.length === 0 || !isAbsolute(path)) return null;
	if (!attached.has(resolve(path))) return null;
	const real = await realpath(path).catch(() => null);
	if (!real) return null;
	const info = await stat(real).catch(() => null);
	return info?.isFile() ? real : null;
}
