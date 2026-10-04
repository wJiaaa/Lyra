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
import type { Message } from "../types.ts";
import { historyUpTo, type BoundaryAt, type DividerAt } from "./replay.ts";

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

	const { messages, boundary, dividers } = await historyUpTo(store, sessionId, seq);
	let meta = await store.create(source.cwd, source.modelId, title ?? `${source.title}（分叉）`, { thinking: source.thinking });
	/*
	 * Where the model changed, carried over — or the fork replays one provider's opaque handles to
	 * another, which rejects them (see `modelSwitchedAt`). A change made after the fork point still
	 * counts: the fork continues on the session's current model, and every message it inherits came
	 * from the one before.
	 */
	const switchedAt = source.modelSwitchedAt === undefined ? 0 : Math.min(source.modelSwitchedAt, messages.length);
	if (switchedAt > 0) meta = (await store.append(meta, { type: "meta", meta: { ...meta, modelSwitchedAt: switchedAt } })) ?? meta;
	/*
	 * 压缩边界跟着消息一起抄过去，写在原来的位置上：载入时 `keptFrom` 由「此刻已有几条 - kept」
	 * 算出，位置对了它就和原会话一致，分叉在这一点看到的模型视图也就是原会话在这一点看到的那份。
	 * 只抄消息的话，模型视图从摘要展开回全部原文，计量却还信压缩后那几条回复的 usage。
	 *
	 * 这条记录的时间是分叉这一刻（存储层给的 `ts`），所以抄过来的回复都早于边界，计量在分叉的
	 * 第一次回复之前按估算走——它们量的是原会话的请求，分叉之后的 system prompt、工具都可能不同。
	 */
	for (const [index, message] of messages.entries()) {
		for (const divider of dividers) if (divider.at === index) meta = await appendDivider(store, meta, divider);
		if (boundary && index === boundary.markAt) meta = await appendBoundary(store, meta, boundary);
		// Copied: these replies were paid for in the original, and the spend table already has them.
		meta = (await store.append(meta, { type: "message", message }, { copy: true })) ?? meta;
	}
	for (const divider of dividers) if (divider.at === messages.length) meta = await appendDivider(store, meta, divider);
	if (boundary && boundary.markAt === messages.length) meta = await appendBoundary(store, meta, boundary);
	return { meta, messages: messages.length };
}

/**
 * Fork from just before a message the person wrote — Claude Code's "Fork from here".
 *
 * The same thing 撤回 does to a conversation, done to a copy: the fork holds everything before the
 * message, and the message itself goes back to the composer (the caller's job) to be sent as it was
 * or rewritten. The original is not touched.
 *
 * The window names the message by its position in the transcript it shows, which is not a sequence
 * number, and positions drift — a message the window drew before the log had it. So the position is
 * checked against the message's timestamp and, when they disagree, the message is looked up by its
 * timestamp; a message that cannot be found is not forked, rather than forking from the wrong place.
 */
export async function forkBeforeMessage(
	store: SessionStorage,
	sessionId: string,
	messageIndex: number,
	timestamp: number,
	title?: string,
): Promise<ForkResult | null> {
	const loaded = await store.load(sessionId);
	if (!loaded) return null;
	const isIt = (message: Message | undefined) => message?.role === "user" && message.timestamp === timestamp;
	const target = isIt(loaded.entries[messageIndex]?.message)
		? loaded.entries[messageIndex]
		: loaded.entries.find((entry) => isIt(entry.message));
	if (!target) return null;
	return forkSession(store, sessionId, target.seq - 1, title);
}

async function appendBoundary(store: SessionStorage, meta: SessionMeta, boundary: BoundaryAt): Promise<SessionMeta> {
	const { summary, keptFrom, markAt, before, after } = boundary;
	return (await store.append(meta, { type: "event", event: { type: "compacted", before, after, summary, kept: markAt - keptFrom } }, { copy: true })) ?? meta;
}

async function appendDivider(store: SessionStorage, meta: SessionMeta, divider: DividerAt): Promise<SessionMeta> {
	const { summary, before, after } = divider;
	return (await store.append(meta, { type: "event", event: { type: "compacted", before, after, summary } }, { copy: true })) ?? meta;
}
