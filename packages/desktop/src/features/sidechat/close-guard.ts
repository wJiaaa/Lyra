/**
 * 关掉一个侧边聊天之前，先看里面有没有东西。
 *
 * 关掉就是删掉（`closeSideChat`）：会话、记录、框里没发出去的字一起没了，拿不回来。空的那一格照旧
 * 一点就关——没有可丢的东西还要问，人就习惯性点「确定」，那这句话就白问了。
 *
 * 问题由正挂着这个侧边聊天的那一格画出来（`SideChat`），和终端的 `close-guard.ts` 一个道理：确认框
 * 要长在组件树里，而关闭是从 store 函数发起的。没有哪一格挂着它时就不问，照旧关——否则没人回答，
 * 这次关闭就永远停在半路。
 */

import type { SessionMeta } from "@plume/core";
import { create } from "zustand";
import type { AppState } from "../../store/index.ts";

/** 勾过「不再询问」并且关掉了一次之后，记在这里。 */
const SKIP_KEY = "plume.sideChat.closeWithoutAsking";

interface Question {
	/** `sideKey(会话, 侧边聊天)`：哪一格来回答。 */
	key: string;
	answer(close: boolean, dontAskAgain?: boolean): void;
}

export const useSideCloseQuestion = create<{ asking: Question | null }>(() => ({ asking: null }));

/** 这个窗口里正挂着的侧边聊天，计数：分屏时同一个可能挂在两格里。 */
const shown = new Map<string, number>();

export function showingSide(key: string): () => void {
	shown.set(key, (shown.get(key) ?? 0) + 1);
	return () => {
		const left = (shown.get(key) ?? 1) - 1;
		if (left > 0) shown.set(key, left);
		else shown.delete(key);
	};
}

/** 有话可画：说过话、或者正在回答。还没读进来的看记录里的条数。 */
export function sideHasTranscript(app: Pick<AppState, "sessionCache">, side: SessionMeta | null): boolean {
	if (!side) return false;
	const cached = app.sessionCache[side.id];
	return cached ? cached.messages.length > 0 || cached.state?.running === true : side.messageCount > 0;
}

/**
 * `true` 就关，`false` 留着。`key` 是 `sideKey(会话, 侧边聊天)`。
 *
 * 里面有没有东西由调用方量好传进来：量它要读 `dock` 的大门，而这个文件不能 import 它——
 * 理由同 `scope.ts`，见 `confirmCloseSideChat`。
 */
export function askBeforeClosing(key: string, hasContent: boolean): Promise<boolean> {
	if (!hasContent || !shown.has(key) || localStorage.getItem(SKIP_KEY) === "1") return Promise.resolve(true);
	return new Promise((resolve) => {
		// 上一个问题还没答又来一个：上一个算「不关」，免得它的 await 永远停在那儿。
		useSideCloseQuestion.getState().asking?.answer(false);
		useSideCloseQuestion.setState({
			asking: {
				key,
				answer: (close, dontAskAgain) => {
					if (useSideCloseQuestion.getState().asking?.key === key) useSideCloseQuestion.setState({ asking: null });
					// 只在真关了的时候记：勾上又点了取消，等于这次没答应。
					if (close && dontAskAgain) localStorage.setItem(SKIP_KEY, "1");
					resolve(close);
				},
			},
		});
	});
}
