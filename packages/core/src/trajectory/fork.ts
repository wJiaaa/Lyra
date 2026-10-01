import type { SessionStorage } from "../session/storage.ts";
/**
 * Starting a new conversation from a point in an old one.
 *
 * The append-only log makes this cheap and honest: everything up to a sequence number is a complete
 * history, so a fork is that history copied into a fresh session. The original is not touched — no
 * truncate record, no rewriting — which is the difference between forking and editing. You can fork
 * the same point twice and compare what happens.
 *
 * Reads through the same path as resuming and replaying; there is one definition of "what had
 * happened by then", and it lives in `replay.ts`.
 */

import type { SessionMeta } from "../session/store.ts";
import { historyUpTo, type BoundaryAt } from "./replay.ts";

export interface ForkResult {
	meta: SessionMeta;
	/** How many messages the fork inherited. */
	messages: number;
}

/**
 * Copy a session's history up to `seq` into a new session.
 *
 * The new session carries the same working directory, model and reasoning level, because a fork is
 * a different continuation of the same work rather than a different piece of work.
 */
export async function forkSession(
	store: SessionStorage,
	sessionId: string,
	seq: number,
	title?: string,
): Promise<ForkResult | null> {
	const source = await store.get(sessionId);
	if (!source) return null;

	const { messages, boundary } = await historyUpTo(store, sessionId, seq);
	let meta = await store.create(source.cwd, source.modelId, title ?? `${source.title}（分叉）`, { thinking: source.thinking });
	/*
	 * 压缩边界跟着消息一起抄过去，写在原来的位置上：载入时 `keptFrom` 由「此刻已有几条 - kept」
	 * 算出，位置对了它就和原会话一致，分叉在这一点看到的模型视图也就是原会话在这一点看到的那份。
	 * 只抄消息的话，模型视图从摘要展开回全部原文，计量却还信压缩后那几条回复的 usage。
	 *
	 * 这条记录的时间是分叉这一刻（存储层给的 `ts`），所以抄过来的回复都早于边界，计量在分叉的
	 * 第一次回复之前按估算走——它们量的是原会话的请求，分叉之后的 system prompt、工具都可能不同。
	 */
	for (const [index, message] of messages.entries()) {
		if (boundary && index === boundary.markAt) meta = await appendBoundary(store, meta, boundary);
		// Copied: these replies were paid for in the original, and the spend table already has them.
		meta = (await store.append(meta, { type: "message", message }, { copy: true })) ?? meta;
	}
	if (boundary && boundary.markAt === messages.length) meta = await appendBoundary(store, meta, boundary);
	return { meta, messages: messages.length };
}

async function appendBoundary(store: SessionStorage, meta: SessionMeta, boundary: BoundaryAt): Promise<SessionMeta> {
	const { summary, keptFrom, markAt, before, after } = boundary;
	return (await store.append(meta, { type: "event", event: { type: "compacted", before, after, summary, kept: markAt - keptFrom } }, { copy: true })) ?? meta;
}
