/**
 * Side chats and the work they hand over, behind the Electron IPC handlers.
 *
 * A side chat is a session of its own (see core `side-session.ts`); everything said in it goes
 * through the same `agent:*` calls as the main conversation. What is left here is the panel's way
 * of naming one — its session plus the panel's own id — and the queue of work it dispatched.
 */

import type { SessionMeta } from "@plume/core";
import { deleteSessions, openSideSession, sessions, sideSessionsOf } from "./session-hub.ts";

const SIDE_ID = /^[a-z0-9]{1,32}$/;

function checkSideId(sideId: unknown): asserts sideId is string {
	// 界面生成的 id：时间戳加随机数的 base36。它也进了会话的 meta，不能是任意字符串。
	if (typeof sideId !== "string" || !SIDE_ID.test(sideId)) throw new Error("Invalid side-chat id");
}

/** 这个会话旁边的那几个侧边聊天：面板据此找到自己背后的会话，环境卡片据此列出没挂出来的。 */
export function sideChatList(sessionId: string): Promise<SessionMeta[]> {
	return sideSessionsOf([sessionId]);
}

/** The session behind a panel, created on the first question. */
export function sideChatOpen(sessionId: string, sideId: string): Promise<SessionMeta> {
	checkSideId(sideId);
	return openSideSession(sessionId, sideId);
}

/** 关掉一格：会话连同它的记录一起删掉。重开就是一段新的，主会话不受影响。 */
export async function sideChatClose(sessionId: string, sideId: string): Promise<void> {
	checkSideId(sideId);
	await deleteSessions((await sideSessionsOf([sessionId])).filter((meta) => meta.sideId === sideId).map((meta) => meta.id));
}

export function tasksList(sessionId: string) {
	return sessions.get(sessionId)?.taskQueue ?? [];
}

export async function tasksCancel(sessionId: string, taskId: string): Promise<boolean> {
	return (await sessions.get(sessionId)?.cancelTask(taskId)) ?? false;
}

export async function tasksDismiss(sessionId: string, taskId: string): Promise<boolean> {
	return (await sessions.get(sessionId)?.dismissTask(taskId)) ?? false;
}

export async function tasksResume(sessionId: string, taskId: string): Promise<boolean> {
	return (await sessions.get(sessionId)?.resumeTask(taskId)) ?? false;
}
