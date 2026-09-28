/**
 * What a sidebar row should show, given the main turn and the side chat.
 *
 * The list only used to watch the main agent. A side chat can run while that turn is idle, and
 * the row then looked finished — the thing the user asked to see as a running mark.
 *
 * The side chat only contributes "still going". Its own finish is not an unread result on this
 * row: the transcript it wrote is in another pane.
 */

import { visibleActivity, type SessionActivity } from "@plume/core/activity";

export interface SideRunningSource {
	/**
	 * 每个会话一份——分屏之后「当前那一份」不再够用，见 `dock/sideStore.ts`。一个会话旁边又可以
	 * 开好几个，里面一层按侧边聊天分。
	 */
	chats: Readonly<Record<string, Readonly<Record<string, { running?: boolean }>>>>;
}

/** 这个会话旁边随便哪一个还在答，这一行就还在动。 */
export function sideChatRunning(state: SideRunningSource, sessionId: string): boolean {
	return Object.values(state.chats[sessionId] ?? {}).some((chat) => chat.running === true);
}

export function rowActivity(
	activity: SessionActivity | null,
	sideRunning: boolean,
	isActive: boolean,
): SessionActivity | null {
	const visible = visibleActivity(activity, isActive);
	if (visible === "running" || visible === "waiting") return visible;
	if (sideRunning) return "running";
	return visible;
}
