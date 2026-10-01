/**
 * Walking the event stream forwards.
 *
 * "What had happened by sequence N" is the question underneath resuming, forking and replaying, so
 * it is answered once, here. Resuming asks for the end of the stream; forking asks for a point in
 * the middle; replaying asks for every point in turn.
 *
 * Truncation is applied as it is met rather than pre-scanned, because that is what it means: a
 * record that voids the tail behind it, in the order it was written.
 */

import type { SessionRecord, SessionStore } from "../session/store.ts";
import type { Message } from "../types.ts";

/** The messages a session held at a given point. Pass `Infinity` for "all of it". */
export async function messagesUpTo(
	store: Pick<SessionStore, "read">,
	sessionId: string,
	seq: number,
): Promise<Message[]> {
	return (await historyUpTo(store, sessionId, seq)).messages;
}

/** 到某一点为止仍然生效的压缩边界，以及写下它时对话走到了第几条（界面在那里画分隔线）。 */
export interface BoundaryAt {
	summary: string;
	keptFrom: number;
	markAt: number;
	before: number;
	after: number;
}

/**
 * 到某一点为止的消息，连同那一刻模型视图的起点。
 *
 * 光有消息不够：日志保留全部原文，模型看到的是「摘要 + 边界之后」，二者只差这个边界。分叉只抄
 * 消息时，新会话把压缩掉的历史整段展开重发，而保留尾部那几条回复的 usage 量的还是压缩后的小请求，
 * 计量就拿这个小数去报一个大得多的上下文。边界的判定照搬 `SessionStore.load`：只认带 `kept` 的
 * `compacted`，截断越过 `keptFrom` 才作废——两处不一致，分叉出来的会话和原会话在同一点就不是同一份视图。
 */
export async function historyUpTo(
	store: Pick<SessionStore, "read">,
	sessionId: string,
	seq: number,
): Promise<{ messages: Message[]; boundary: BoundaryAt | null }> {
	const kept: { seq: number; message: Message }[] = [];
	let boundary: BoundaryAt | null = null;
	for await (const record of store.read(sessionId)) {
		if (record.seq > seq) break;
		if (record.type === "truncate") {
			const cutoff = record.afterSeq;
			while (kept.length > 0 && kept[kept.length - 1].seq > cutoff) kept.pop();
			if (boundary && boundary.keptFrom > kept.length) boundary = null;
			else if (boundary) boundary.markAt = Math.min(boundary.markAt, kept.length);
			continue;
		}
		if (record.type === "message") kept.push({ seq: record.seq, message: record.message });
		else if (record.type === "event" && record.event.type === "compacted" && record.event.kept !== undefined) {
			const { summary, kept: count, before, after } = record.event;
			boundary = { summary: summary ?? "", keptFrom: Math.max(0, kept.length - count), markAt: kept.length, before, after };
		}
	}
	return { messages: kept.map((entry) => entry.message), boundary };
}

/**
 * Every record in order, as steps.
 *
 * A generator rather than an array: a replay is watched one step at a time, and a long session's
 * records are the one thing in this app that genuinely does not fit comfortably in memory.
 */
export async function* replaySession(
	store: Pick<SessionStore, "read">,
	sessionId: string,
	sinceSeq = 0,
): AsyncGenerator<SessionRecord> {
	for await (const record of store.read(sessionId, sinceSeq)) yield record;
}
