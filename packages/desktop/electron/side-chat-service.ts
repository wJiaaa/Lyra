/** Side-chat operations behind the Electron IPC handlers. */

import { SideChat, restoredSideChatMessages, type SideAskOptions, type SideChatEvent, type UserContent } from "@lyra/core";
import { settings } from "./app-settings.ts";
import { broadcastSideChat, ensureLiveSession, liveSideChat, sessions, sideChats } from "./session-hub.ts";
import { DEFAULT_SIDE_CHAT_ID } from "@lyra/contract";
import { isSideId, loadSideChatSnapshot, saveSideChatTranscript, saveSideChat } from "./sidechat-store.ts";

const opening = new Map<string, Promise<SideChat | null>>();

function reportError(sessionId: string, sideId: string, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	broadcastSideChat(sessionId, sideId, { type: "notice", level: "error", message });
	broadcastSideChat(sessionId, sideId, { type: "agent_end", reason: "error", error: message });
}

function checkSideId(sideId: string): void {
	if (!isSideId(sideId)) throw new Error("Invalid side-chat id");
}

async function ensureSideChat(sessionId: string, sideId: string): Promise<SideChat | null> {
	checkSideId(sideId);
	const existing = liveSideChat(sessionId, sideId);
	if (existing) {
		existing.updateSettings(settings());
		return existing;
	}
	const key = `${sessionId}/${sideId}`;
	const pending = opening.get(key);
	if (pending) return pending;

	const operation = (async () => {
		const main = await ensureLiveSession(sessionId);
		if (!main) return null;
		const chat: SideChat = new SideChat({
			main,
			// 最早那一个不带 id，缓存 key 和从前一样。
			...(sideId === DEFAULT_SIDE_CHAT_ID ? {} : { sideId }),
			settings: settings(),
			persistModel: (modelId) => saveSideChat(sessionId, chat.messages, modelId, sideId),
			persistReset: (modelId) => saveSideChat(sessionId, [], modelId, sideId),
			emit: async (event: SideChatEvent) => {
				broadcastSideChat(sessionId, sideId, event);
				if (event.type === "message_end" && event.message.role === "assistant" && event.message.usage) {
					try {
						await main.log.append({
							type: "usage",
							source: "side-chat",
							providerId: event.message.provider,
							modelId: event.message.model,
							usage: event.message.usage,
						});
					} catch (error) {
						console.error("[sidechat] Failed to record usage", error);
					}
				}
				if (event.type !== "message_end" && event.type !== "rewound") return;
				// 关掉之后还在收尾的那一轮不能把存档写回来。
				if (liveSideChat(sessionId, sideId) !== chat) return;
				try {
					await saveSideChatTranscript(sessionId, chat.messages, chat.state().modelId, sideId);
				} catch (error) {
					console.error("[sidechat] Failed to persist transcript", error);
					broadcastSideChat(sessionId, sideId, {
						type: "notice",
						level: "error",
						message: "侧边聊天保存失败，请检查存储空间与目录权限。",
					});
				}
			},
		});
		const snapshot = await loadSideChatSnapshot(sessionId, sideId);
		chat.restore(snapshot.messages, snapshot.modelId);
		const chats = sideChats.get(sessionId) ?? new Map<string, SideChat>();
		chats.set(sideId, chat);
		sideChats.set(sessionId, chats);
		return chat;
	})();
	opening.set(key, operation);
	try {
		return await operation;
	} finally {
		if (opening.get(key) === operation) opening.delete(key);
	}
}


export async function sideChatState(sessionId: string, sideId: string) {
	checkSideId(sideId);
	const existing = liveSideChat(sessionId, sideId);
	if (existing) return existing.state();
	const { messages, modelId = settings().sideChatModelId || null } = await loadSideChatSnapshot(sessionId, sideId);
	const created = await opening.get(`${sessionId}/${sideId}`) ?? liveSideChat(sessionId, sideId);
	return created ? created.state() : { messages: restoredSideChatMessages(messages), modelId, running: false, revision: 0 };
}

export async function sideChatSetModel(sessionId: string, sideId: string, modelId: string | null): Promise<void> {
	if (modelId !== null && typeof modelId !== "string") throw new Error("Invalid side-chat model");
	const chat = await ensureSideChat(sessionId, sideId);
	if (!chat) throw new Error(`Session ${sessionId} is not open.`);
	await chat.setModel(modelId);
}

export async function sideChatAsk(sessionId: string, sideId: string, content: UserContent[], options?: SideAskOptions): Promise<void> {
	const chat = await ensureSideChat(sessionId, sideId);
	if (!chat) throw new Error(`Session ${sessionId} is not open.`);
	// 不给 `thinking` 就回落到主会话，再回落到全局设置——见 `sidechat.ts` 的 `run`。
	void chat.ask(content, options ?? {}).catch((error: unknown) => reportError(sessionId, sideId, error));
}

export async function sideChatEditAndResend(sessionId: string, sideId: string, index: number, content: UserContent[], options?: SideAskOptions): Promise<void> {
	const chat = await ensureSideChat(sessionId, sideId);
	if (!chat) throw new Error(`Session ${sessionId} is not open.`);
	void chat.editAndResend(index, content, options ?? {}).catch((error: unknown) => reportError(sessionId, sideId, error));
}

export function sideChatAbort(sessionId: string, sideId: string): void {
	liveSideChat(sessionId, sideId)?.abort();
}

export async function sideChatReset(sessionId: string, sideId: string): Promise<void> {
	const chat = await ensureSideChat(sessionId, sideId);
	if (!chat) throw new Error(`Session ${sessionId} is not open.`);
	await chat.restart();
}

/**
 * 关掉一个侧边聊天：停下、从内存里拿掉、存档删掉。
 *
 * 不经过 `ensureSideChat`——关一个没开过的不该先把主会话拉起来。
 */
export async function sideChatClose(sessionId: string, sideId: string): Promise<void> {
	checkSideId(sideId);
	await opening.get(`${sessionId}/${sideId}`)?.catch(() => null);
	const chats = sideChats.get(sessionId);
	chats?.get(sideId)?.reset();
	chats?.delete(sideId);
	if (chats?.size === 0) sideChats.delete(sessionId);
	await saveSideChat(sessionId, [], undefined, sideId);
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
