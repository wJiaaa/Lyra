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

/** 侧边聊天里界面块的状态记在哪个 key 下：同一段原文在主对话和每个侧边聊天各记各的。 */
export function sideInterfaceKey(sessionId: string, sideId: string): string {
	return `${sessionId}/side/${sideId}`;
}
