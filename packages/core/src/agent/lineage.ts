/**
 * 上一次真正发出去的主请求，记在会话状态图里：压缩的摘要请求从这里分叉。
 *
 * 摘要请求要吃到主循环的缓存，就得和上一次请求逐字节同一个前缀——同样的工具、系统提示词、thinking、
 * 缓存键，消息只在末尾多一条指令。靠压缩那边照着主请求「再拼一份」是拼不准的（别家漏过一个工具、
 * 换过一块 system），所以这里不让它拼：请求头从发出去的那一次原样记下，分叉只能往后接消息。
 * 设计和取舍见 docs/architecture/context-assembly.md「压缩请求从主请求分叉」。
 */

import type { PrefixSegment } from "../ai/prefix-fingerprint.ts";
import type { CompactionLineage, SentRequest } from "../types/compaction.ts";
import type { Message } from "../types.ts";

const SENT_KEY = "sentRequest";
/** 上一次请求体的分段指纹，缓存诊断和分叉前的核对共用。见 `streamTurn` 里的 `stamp`。 */
const PREFIX_KEY = "requestPrefix";

export function recordSent(state: Map<string, unknown>, sent: SentRequest): void {
	state.set(SENT_KEY, sent);
}

export function lastSegments(state: Map<string, unknown>): PrefixSegment[] | undefined {
	return state.get(PREFIX_KEY) as PrefixSegment[] | undefined;
}

export function recordSegments(state: Map<string, unknown>, segments: PrefixSegment[]): void {
	state.set(PREFIX_KEY, segments);
}

/** 从上一次请求分叉，消息换成 `messages`（发送形态）。没发过请求的会话没有可分叉的前缀。 */
export function lineageFrom(state: Map<string, unknown> | undefined, messages: Message[]): CompactionLineage | undefined {
	const sent = state?.get(SENT_KEY) as SentRequest | undefined;
	if (!sent) return undefined;
	const segments = lastSegments(state!);
	return { sent, messages, ...(segments ? { segments } : {}) };
}
