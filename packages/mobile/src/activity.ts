import type { Message } from "@plume/client-runtime";
import { moodFor, type Mood } from "@plume/client-runtime/running";
import { toolSubject } from "./tools.ts";

/** 刚做完的一步再占这一行这么久：读文件、列目录几十毫秒就完，不留一下，它代表的状态从来没在屏幕上出现过。和桌面同一个数。 */
const TOOL_HOLD_MS = 2000;

export interface Activity { mood: Mood; startedAt: number | null; tokens: number }

/**
 * 正在跑的这一轮，读成桌面运行行要的三样：在干什么（mood）、从什么时候开始、这一轮用了多少 token。
 *
 * 桌面从 store 里现成的工具运行表和计量器读；手机只有消息，于是从消息里推：
 * - 一轮从最后一条用户消息开始；
 * - 在跑的工具是还没有结果的那次调用，没有就看刚做完不到两秒的那次（结果消息的时间）；
 * - 没有工具时，最后一条回复还在流、末尾是正文，就是在写回答，否则是在想；
 * - token 是这一轮每条回复的 input + cacheWrite + output——和 core 的 `freshTokens` 同一个口径，
 *   手机只能引用 core 的类型，所以在这里照着写一遍。
 */
export function activityOf(messages: Message[], now: number): Activity {
	let start = messages.length;
	while (start > 0 && messages[start - 1]!.role !== "user") start--;
	const turn = messages.slice(start);
	const startedAt = start > 0 ? messages[start - 1]!.timestamp : null;
	const calls = new Map<string, { name: string; args: unknown; finishedAt?: number }>();
	let tokens = 0;
	for (const message of turn) {
		if (message.role === "assistant") {
			tokens += message.usage.input + message.usage.cacheWrite + message.usage.output;
			for (const part of message.content) if (part.type === "toolCall") calls.set(part.id, { name: part.name, args: part.arguments });
		} else if (message.role === "toolResult") {
			const call = calls.get(message.toolCallId);
			if (call) call.finishedAt = message.timestamp;
		}
	}
	const all = [...calls.values()];
	const running = all.findLast((call) => call.finishedAt === undefined);
	let finished: (typeof all)[number] | undefined;
	for (const call of all) if (call.finishedAt !== undefined && (!finished || call.finishedAt > finished.finishedAt!)) finished = call;
	const doing = running ?? (finished && now - finished.finishedAt! < TOOL_HOLD_MS ? finished : undefined);
	const last = turn.at(-1);
	const block = last?.role === "assistant" && last.stopReason === "pending" ? last.content.at(-1) : undefined;
	const writing = block?.type === "text" && block.text.length > 0;
	return { mood: moodFor(doing?.name, doing ? toolSubject(doing.name, doing.args) : undefined, false, writing), startedAt, tokens };
}
