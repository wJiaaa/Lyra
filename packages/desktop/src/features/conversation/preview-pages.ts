/**
 * 先检查、再按 id 发布的页面，在对话里由哪一次调用来画。
 *
 * 检查和发布是两次调用，中间隔着模型的一整轮推理。各画各的时候，检查的那一页写完就收走、发布的那一页
 * 要等模型想完才出来：一页出现、消失十几秒、再在下面另起一张。所以同一轮里的这一对由检查那一次画到底：
 * 写的时候是草稿，检查完、等发布时草稿留着，发布了就在原地换成正式页面；发布那一次只是过程里的一行。
 *
 * 检查过、这一轮却结束了还没发布的，不是给人看的页面，跟着过程收起来。隔了一轮才发布（人看过截图说
 * 「发吧」）的，页面画在发布那一次上——画回上一轮，人在底下是看不见的。
 */

import type { AssistantContent, Message } from "@plume/core";
import { routedBlock } from "../../lib/tool-summary.ts";

type ToolCallBlock = Extract<AssistantContent, { type: "toolCall" }>;

/**
 * - `waiting`：检查的那一页，还在写、在检查，或者检查完在等发布。
 * - `publishedBy`：检查的那一页已经被这一次调用发布，正式页面画在检查这一次上。
 * - `publishing`：按 id 发布的那一次，页面由它发布的那次检查来画，它自己是一行。
 */
export type PageState = { waiting: true } | { publishedBy: string } | { publishing: true };

/** 回复以这些结束，这一轮就停了：之后不会再有发布。 */
const OVER = new Set(["stop", "length", "error", "aborted"]);

/**
 * 一次 preview 调用说了什么。
 *
 * 写着的时候 `arguments` 还是空的，只有 `argumentsText` 在长（见各家 provider），所以那时读原文。
 * 不整段解析：一页有上万字，转录每变一次都要过一遍。字符串里的引号是转义过的，前面不是 `\` 的
 * `"check"` 只可能是键。
 */
function intent(block: ToolCallBlock): { check: boolean; publish?: string; started: boolean } {
	const args = block.arguments ?? {};
	if (Object.keys(args).length > 0) {
		return { check: args.check === true, publish: typeof args.id === "string" ? args.id : undefined, started: true };
	}
	const text = block.argumentsText ?? "";
	const id = /(?<!\\)"id"\s*:\s*"([^"\\]*)("?)/.exec(text);
	return {
		check: /(?<!\\)"check"\s*:\s*true/.test(text),
		// 还没写完的 id 先记成空串：知道是在发布，还不知道发布哪一页。
		publish: id ? (id[2] ? id[1] : "") : undefined,
		started: /"[^"]*"\s*:/.test(text),
	};
}

/**
 * 每一次和检查、发布有关的 preview 调用，按调用 id。没有登记的照旧：直接发布的就是页面，检查失败的、
 * 没等到发布的是过程。
 *
 * `turnStarts(index)`：第 `index` 条消息是不是开了新的一轮，由 `grouping.ts` 判。
 */
export function previewPages(messages: Message[], turnStarts: (index: number) => boolean): Map<string, PageState> {
	const out = new Map<string, PageState>();
	const failed = new Set<string>();
	for (const message of messages) if (message.role === "toolResult" && message.isError) failed.add(message.toolCallId);

	let turn = 0;
	/** 检查过的页面 id → 那次检查的调用和它所在的一轮。 */
	const checks = new Map<string, { call: string; turn: number }>();
	/** 最近一次开始写一页的调用：只有它可能还在等发布。 */
	let latest: { call: string; check: boolean; turn: number; over: boolean } | null = null;
	/** 有过发布的页面，不管成没成：发布失败的那一页不再等，跟着过程收起来。 */
	const tried = new Set<string>();

	for (const [index, message] of messages.entries()) {
		if (turnStarts(index)) {
			turn++;
			if (latest) latest.over = true;
		}
		if (message.role === "toolResult") {
			const details = message.details as { kind?: string; id?: unknown } | undefined;
			if (!message.isError && details?.kind === "preview-check" && typeof details.id === "string") checks.set(details.id, { call: message.toolCallId, turn });
			continue;
		}
		if (message.role !== "assistant") continue;
		for (const raw of message.content) {
			if (raw.type !== "toolCall") continue;
			const block = routedBlock(raw);
			if (block.name !== "preview") continue;
			const { check, publish, started } = intent(block);
			if (publish === undefined) {
				// 还一个字没写的，看不出是新的一页还是发布，不顶掉在等的那一页。
				if (started) latest = { call: block.id, check, turn, over: false };
				continue;
			}
			const target = publish ? checks.get(publish) : undefined;
			if (target && target.turn === turn) {
				tried.add(target.call);
				out.set(block.id, { publishing: true });
				if (!failed.has(block.id)) out.set(target.call, { publishedBy: block.id });
			} else if (!publish && latest?.check && latest.turn === turn) {
				// id 还在写：多半是发布刚检查过的那一页，先当它是，免得它在页面那一格里冒一下又收走。
				out.set(block.id, { publishing: true });
			}
		}
		if (latest && OVER.has(message.stopReason)) latest.over = true;
	}

	if (latest?.check && !latest.over && !failed.has(latest.call) && !tried.has(latest.call)) out.set(latest.call, { waiting: true });
	return out;
}

/** 两次分组之间，同一次调用的状态变没变——`sameRun` 用。 */
export function samePage(before: PageState | undefined, after: PageState | undefined): boolean {
	if (!before || !after) return before === after;
	if ("waiting" in before) return "waiting" in after;
	if ("publishing" in before) return "publishing" in after;
	return "publishedBy" in after && after.publishedBy === before.publishedBy;
}
