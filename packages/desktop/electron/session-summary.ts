/**
 * 会话摘要：存在哪、怎么生成、什么时候生成。
 *
 * 一轮结束、一分钟里没有下一轮，就在后台生成（`summarizeAfterTurn`），不管卡片开没开。原先由
 * 卡片开着时渲染层来要，于是点开一个早就停下的旧会话也会立刻花一次，而真在干活的会话不点开就一直
 * 没有。现在花钱只跟「这个会话刚干完一段活」走，翻旧会话只读存着的那份。
 *
 * 存成旁挂文件 `~/.plume/summaries/<会话>.json`，不写进会话记录。写进记录有两处要出事：
 * 记一笔用量会把会话的 `updatedAt` 改成现在，每生成一次摘要它就被顶到侧栏最上面；而正在跑的
 * 会话手里攥着一份旧 meta，它下一次写 meta 会把摘要盖回去。和侧边聊天的存档是同一个做法，
 * 会话删掉时一起清掉（`session-hub.ts` 的 `deleteSessions`）。
 *
 * 模型在设置的「会话」分组里单独选（`summaryModelId`），没选就用会话自己的模型。花销照样记账，
 * 经 `recordUsage` 记在会话之外——设置页的花销里看得到，会话的用量不跟着变。
 */

import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
	plumeHome,
	resolveModel,
	resolveModelRef,
	streamAssistant,
	summarizeSession,
	writeFileAtomic,
	type AgentEvent,
	type Message,
	type SessionStorage,
	type Settings,
} from "@plume/core";

export interface StoredSummary {
	text: string;
	/** 已经概括进去的最后一条消息的 `timestamp`。 */
	upto: number;
	updatedAt: number;
}

export type SummarizeResult = { summary: StoredSummary | null; error?: string };

/** 推给窗口的那一份：后台开始生成时 `pending` 为真，生成完带着结果再推一次。 */
export type SummaryUpdate = { sessionId: string; pending: boolean; summary?: StoredSummary | null; error?: string };

/** 一轮结束后静多久才生成：一问一答连着来的时候，不为每一轮各花一次。 */
const AFTER_TURN_IDLE_MS = 60_000;

function fileFor(sessionId: string): string {
	if (!sessionId || /[\\/\0:]/.test(sessionId) || sessionId === "." || sessionId === "..") throw new Error("Invalid session id");
	return join(plumeHome(), "summaries", `${sessionId}.json`);
}

export async function readSummary(sessionId: string): Promise<StoredSummary | null> {
	const raw = await readFile(fileFor(sessionId), "utf8").catch(() => null);
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as Partial<StoredSummary>;
		if (typeof parsed.text !== "string" || !parsed.text || typeof parsed.upto !== "number" || typeof parsed.updatedAt !== "number") return null;
		return { text: parsed.text, upto: parsed.upto, updatedAt: parsed.updatedAt };
	} catch {
		return null;
	}
}

export async function removeSummary(sessionId: string): Promise<void> {
	await rm(fileFor(sessionId), { force: true });
}

/** 同一个会话同时只跑一次：卡片在两个分屏里各开一张时，两边要的是同一份。 */
const inFlight = new Map<string, Promise<SummarizeResult>>();

export function summarize(
	sessionId: string,
	deps: { store: SessionStorage; settings: Settings; liveMessages?: readonly Message[] },
): Promise<SummarizeResult> {
	const running = inFlight.get(sessionId);
	if (running) return running;
	const next = run(sessionId, deps).finally(() => inFlight.delete(sessionId));
	inFlight.set(sessionId, next);
	return next;
}

async function run(sessionId: string, { store, settings, liveMessages }: { store: SessionStorage; settings: Settings; liveMessages?: readonly Message[] }): Promise<SummarizeResult> {
	const previous = await readSummary(sessionId);
	const meta = await store.get(sessionId);
	if (!meta) return { summary: null };
	const messages = liveMessages ?? (await store.messages(sessionId));
	// 会话记着的模型可能已经从设置里删了，那就退到默认模型；两个都没有就没法生成。
	const fallback = resolveModel(settings, meta.modelId || settings.defaultModelId) ?? resolveModel(settings, settings.defaultModelId);
	if (!fallback) return { summary: previous, error: "no model" };
	const chosen = resolveModelRef(settings, settings.summaryModelId, fallback);
	const result = await summarizeSession({
		messages,
		previous,
		provider: chosen.provider,
		model: chosen.model,
		stream: streamAssistant,
		retryPolicy: () => settings.retryPolicy,
		signal: AbortSignal.timeout(45_000),
	});
	// 没有新材料：没发请求，原来那份就是答案。
	if (!result) return { summary: previous };
	if (result.usage) await store.recordUsage({ source: "session-summary", providerId: chosen.provider.id, modelId: chosen.model.modelId, usage: result.usage }).catch(() => {});
	if (!result.summary) return { summary: previous, ...(result.error ? { error: result.error } : {}) };
	const stored: StoredSummary = { ...result.summary, updatedAt: Date.now() };
	// 生成的这几秒里会话可能被删了：不让一份摘要把它的目录又建回来。
	if (!(await store.get(sessionId))) return { summary: null };
	await mkdir(join(plumeHome(), "summaries"), { recursive: true });
	await writeFileAtomic(fileFor(sessionId), JSON.stringify(stored));
	return { summary: stored };
}

/**
 * 每轮结束后排一次，下一轮开始就撤掉；到点时这个会话还在跑（排队的下一轮已经接上）也不要。
 * 有没有新的话由 `summarize` 判断，没有就不发请求，所以一轮只跑了工具不说话也不会白花。
 */
export function summarizeAfterTurn(deps: { busy(sessionId: string): boolean; run(sessionId: string): Promise<void>; idleMs?: number }) {
	const timers = new Map<string, ReturnType<typeof setTimeout>>();
	const cancel = (sessionId: string) => {
		clearTimeout(timers.get(sessionId));
		timers.delete(sessionId);
	};
	return {
		observe(sessionId: string, event: AgentEvent): void {
			if (event.type === "agent_start") cancel(sessionId);
			if (event.type !== "agent_end") return;
			cancel(sessionId);
			const timer = setTimeout(() => {
				timers.delete(sessionId);
				if (deps.busy(sessionId)) return;
				void deps.run(sessionId).catch((error: unknown) => console.error("[session-summary] background summary failed", error));
			}, deps.idleMs ?? AFTER_TURN_IDLE_MS);
			// 退出应用不等它：没生成的那份，下一轮结束时会连同新的话一起补上。
			timer.unref?.();
			timers.set(sessionId, timer);
		},
	};
}
