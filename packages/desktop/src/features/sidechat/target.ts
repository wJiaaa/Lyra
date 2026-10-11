/**
 * 这个面板画的是哪一个侧边聊天。
 *
 * 一个会话旁边可以开好几个，每个占 dock 里的一格；是哪一个看这一格的 kind（见 `lib/panel-instance.ts`）。
 * 会话从 `scope.ts` 来。和它一样不碰 dock 的大门，理由见那个文件开头。
 */

import { DEFAULT_SIDE_CHAT_ID } from "@plume/contract";
import { usePanelKind } from "../../app/session-scope.tsx";
import { sideIdOfPanel } from "../../lib/panel-instance.ts";
import { useSideSessionId } from "./scope.ts";

export function useSideTarget(): { sessionId: string | null; sideId: string } {
	const sessionId = useSideSessionId();
	const kind = usePanelKind();
	return { sessionId, sideId: (kind && sideIdOfPanel(kind)) || DEFAULT_SIDE_CHAT_ID };
}

/** 这个侧边聊天的草稿存在 `useApp.drafts` 的哪个键下。最早那一个沿用一个会话只有一个侧边聊天时的键。 */
export function sideDraftKey(sessionId: string, sideId: string): string {
	return sideId === DEFAULT_SIDE_CHAT_ID ? `side:${sessionId}` : `side:${sessionId}:${sideId}`;
}
