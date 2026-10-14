import { create } from "zustand";
import type { SessionMeta } from "@plume/core";
import { SPAWN_SESSION_TOOL, type SessionSuggestionDetails } from "../../shared/session-suggestion.ts";
import type { ToolRun } from "./tool-run.ts";

/**
 * 一个对话里模型建议另开的会话（`spawn_session`），以及人收起了哪几条。
 *
 * 放在 `store/`：环境卡片那一节（`features/environment`）、标题栏按钮上的圆点、对话里那一行记录
 * （`features/conversation`）读的是同一份，跨了域。数据不另存：建议从这个对话的工具结果里读，「开没
 * 开始」从会话列表的 `spawnedFrom` 读（ADR-0049），这里只多记一样——收起了哪几条。
 */

export interface SessionSuggestion {
	callId: string;
	details: SessionSuggestionDetails;
}

/** 按调用先后排。参数被退回、还没返回的调用都不算：工具那一行自己说了哪里不对。 */
export function suggestionsIn(runs: Record<string, ToolRun>): SessionSuggestion[] {
	return Object.values(runs)
		.filter((run) => run.toolName === SPAWN_SESSION_TOOL && run.status === "done" && (run.result?.details as SessionSuggestionDetails | undefined)?.kind === "session_suggestion")
		.sort((a, b) => a.startedAt - b.startedAt)
		.map((run) => ({ callId: run.toolCallId, details: run.result?.details as SessionSuggestionDetails }));
}

/**
 * 由这条建议开出来的会话。比对要连提建议的对话一起：分叉出来的对话带着同一个调用 id，那边开的
 * 不算这边的。
 */
export function startedFrom(sessions: SessionMeta[], sessionId: string, callId: string): SessionMeta | undefined {
	return sessions.find((one) => one.spawnedFrom?.sessionId === sessionId && one.spawnedFrom.toolCallId === callId);
}

/** 开出来的那个会话在做什么，读侧栏行首那份 `activity`：环境卡片那一行和对话里那一行说同一句话。 */
export function suggestionStatus(activity: string | null): "sessionOps.running" | "sessionOps.done" | "sessionOps.failed" | "sessionOps.started" {
	if (activity === "running" || activity === "waiting") return "sessionOps.running";
	if (activity === "done") return "sessionOps.done";
	if (activity === "failed") return "sessionOps.failed";
	// 看过之后 activity 清掉了，只剩「开始过」这件事。
	return "sessionOps.started";
}

/** 还在等人决定的几条：没开始、也没收起。标题栏按钮上那个圆点就看它有没有。 */
export function pendingSuggestions(runs: Record<string, ToolRun>, sessions: SessionMeta[], sessionId: string, dismissed: readonly string[]): SessionSuggestion[] {
	return suggestionsIn(runs).filter((one) => !dismissed.includes(one.callId) && !startedFrom(sessions, sessionId, one.callId));
}

/**
 * 收起只是这台机器上的事：建议还在记录里，手机或别的窗口也许还要它。按调用 id 记在 localStorage，
 * 放进 store 是为了收起的那一刻圆点、那一节、对话里那一行一起变。
 */
const DISMISSED_KEY = "plume.sessionSuggestions.dismissed";
/** 远多于一个对话会提的条数；超过就忘掉最早的，而不是让这份单子一直长。 */
const DISMISSED_KEEP = 200;

function readDismissed(): string[] {
	try {
		const parsed: unknown = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? "[]");
		return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
	} catch {
		return [];
	}
}

export const useDismissedSuggestions = create<{ ids: string[] }>(() => ({ ids: readDismissed() }));

export function dismissSuggestion(callId: string): void {
	const ids = [...useDismissedSuggestions.getState().ids.filter((one) => one !== callId), callId].slice(-DISMISSED_KEEP);
	useDismissedSuggestions.setState({ ids });
	try {
		localStorage.setItem(DISMISSED_KEY, JSON.stringify(ids));
	} catch {
		// 存不下就只在这次窗口里收起。
	}
}
