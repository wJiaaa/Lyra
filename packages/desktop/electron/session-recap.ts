/**
 * 会话回顾，主进程这一侧：读转录、看缓存、请求模型、写日志。
 *
 * 不为它启动会话。回顾是看一眼的事，和读转录一样不该付 MCP、技能那一整套的启动钱——活着的
 * 会话经它自己的日志写，没活的直接写存储，跟改名走的是同一条路。
 */

import { recapCovers, writeRecap, type AgentSession, type SessionRecap, type SessionStorage, type Settings } from "@plume/core";

type RecapReply = { ok: true; recap: SessionRecap } | { ok: false; reason: "gone" | "empty" | "model" | "failed" };

/** 同一个会话同时只请求一次：分屏两边、`/recap` 和自动触发撞在一起时共用一个结果。 */
const pending = new Map<string, Promise<RecapReply>>();

/** `live` 是这个会话活着时的那个实例，由调用方从会话表里取。 */
export function recapSession(store: SessionStorage, settings: () => Settings, sessionId: string, live: AgentSession | undefined): Promise<RecapReply> {
	const running = pending.get(sessionId);
	if (running) return running;
	const task = generate(store, settings, sessionId, live).finally(() => pending.delete(sessionId));
	pending.set(sessionId, task);
	return task;
}

async function generate(store: SessionStorage, settings: () => Settings, sessionId: string, live: AgentSession | undefined): Promise<RecapReply> {
	const meta = live?.meta ?? (await store.get(sessionId));
	if (!meta) return { ok: false, reason: "gone" };
	const messages = live ? live.messages : await store.messages(sessionId);
	if (meta.recap && recapCovers(meta.recap, messages)) return { ok: true, recap: meta.recap };
	try {
		const outcome = await writeRecap({ messages, previous: meta.recap, settings: settings(), modelId: meta.modelId });
		if ("skipped" in outcome) return { ok: false, reason: outcome.skipped };
		let written: SessionRecap | undefined;
		if (live) {
			await live.log.append(outcome.record);
			written = live.meta.recap;
		} else written = (await store.append(meta, outcome.record))?.recap;
		return outcome.record.text && written ? { ok: true, recap: written } : { ok: false, reason: "failed" };
	} catch (cause) {
		console.error("[recap] Failed to write a recap", cause);
		return { ok: false, reason: "failed" };
	}
}
