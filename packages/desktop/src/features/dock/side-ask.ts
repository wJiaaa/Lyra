/**
 * 对着一格侧边聊天说话：找到（或者建出）它背后的会话，再像对任何会话一样发过去。
 *
 * 侧边聊天是一个真的会话（`SessionMeta.parentId`），问、停、编辑重问、排队都走主对话那几条路，只是
 * 指名这个会话——它从不上台，转录在 `sessionCache` 里。这里补的是那几条路不知道的一步：一格面板
 * 背后的会话要到第一次开口（或者先挑了模型）时才建。
 *
 * 放在 dock 而不是 sidechat：主输入框的「在侧边聊天中打开」也要它，而 sidechat 自己引着输入框那个
 * 域，从输入框反过来引 sidechat 会连成一个环。
 */

import type { MessageAttachment, SessionMeta, ThinkingLevel, UserContent } from "@plume/core";
import { translate } from "../../i18n/translate.ts";
import { bridge } from "../../services/index.ts";
import { useApp } from "../../store/index.ts";
import { readSideSession } from "../../store/session-read.ts";
import { useSide } from "./sideStore.ts";

/** 把这个侧边聊天会话读进缓存，面板从那里画。已经在手上的不重读。 */
export async function loadSide(meta: SessionMeta): Promise<void> {
	const state = useApp.getState();
	if (state.sessionCache[meta.id]) return;
	// 刚建出来、一句话还没有的：没什么可读，直接放一份空的，发出去的那句好有地方先画上。
	if (meta.messageCount === 0) {
		useApp.setState({
			sessionCache: { ...state.sessionCache, [meta.id]: {
				meta, messages: [], toolRuns: {},
				state: { running: false, approvals: [], todos: [], compactions: [], stopped: null, retrying: null, capabilities: null, pendingUserMessage: null },
			} },
		});
		return;
	}
	await readSideSession(meta, useApp.setState, useApp.getState);
}

/** 这一格背后的会话，没有就建一个，并且已经在缓存里。建不出来时已经告诉了人，返回 null。 */
async function sideSession(sessionId: string, sideId: string): Promise<SessionMeta | null> {
	try {
		const meta = await useSide.getState().open(sessionId, sideId);
		await loadSide(meta);
		return meta;
	} catch (cause) {
		useApp.getState().notify(translate("turn.sendFailed", { reason: cause instanceof Error ? cause.message : String(cause) }), "error");
		return null;
	}
}

export async function askSide(
	sessionId: string,
	sideId: string,
	content: UserContent[],
	display: { displayText?: string; attachments?: MessageAttachment[] } = {},
): Promise<boolean> {
	const side = await sideSession(sessionId, sideId);
	if (!side) return false;
	return useApp.getState().send(content, {
		sessionId: side.id,
		...(display.displayText !== undefined ? { displayText: display.displayText } : {}),
		...(display.attachments?.length ? { attachments: display.attachments } : {}),
	});
}

/** 这一格用哪个模型。空串是跟着主会话。 */
export async function setSideModel(sessionId: string, sideId: string, modelId: string): Promise<void> {
	const side = await sideSession(sessionId, sideId);
	if (!side) return;
	// 先画上：标签和下拉读的是这一份，等一来一回才变，看着像没点着。真正的那份随后由 `sessions:changed` 送来。
	useSide.getState().noteSide({ ...side, modelId });
	try { await bridge.agent.setModel(side.id, modelId); }
	catch (cause) {
		useSide.getState().noteSide(side);
		useApp.getState().notify(String(cause instanceof Error ? cause.message : cause), "error");
	}
}

/** 这一格想多久。`null` 是跟着主会话。 */
export async function setSideThinking(sessionId: string, sideId: string, level: ThinkingLevel | null): Promise<void> {
	const side = await sideSession(sessionId, sideId);
	if (!side) return;
	const { thinking: _was, ...rest } = side;
	useSide.getState().noteSide(level ? { ...rest, thinking: level } : rest);
	try { await bridge.agent.setThinking(side.id, level); }
	catch (cause) {
		useSide.getState().noteSide(side);
		useApp.getState().notify(translate("turn.thinkingFailed", { reason: cause instanceof Error ? cause.message : String(cause) }), "error");
	}
}
