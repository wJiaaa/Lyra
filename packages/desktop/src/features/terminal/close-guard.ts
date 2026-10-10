/**
 * 关掉一格终端之前，先看它是不是正跑着东西。
 *
 * 关一格就是结束它的 shell（见 `closeTerminal`），连同里面的 dev server、跑到一半的构建。标签上的
 * ✕ 和别的 ✕ 长得一样，顺手一点就没了，而且拿不回来。所以只在前台不是 shell 本身时问一句；
 * 停在提示符上的终端照旧一点就关，问多了人就习惯性点「确定」，那这句话就白问了。
 *
 * 问题由正显示着那个 shell 的那一格画出来（`TerminalPane`），因为确认框要长在组件树里，而关闭
 * 是从 store 函数发起的。没有哪一格正显示它时——比如它在另一个窗口——就不问，照旧关。
 */

import { create } from "zustand";
import { panelInstance } from "../../lib/panel-instance.ts";
import { savedTerminal, useTerminals } from "../../store/terminals.ts";
import { terminalSlot } from "./scope.ts";

interface Question {
	/** Which shell; the pane showing it is the one that asks. */
	id: string;
	/** What closing would end, named in the question. */
	process: string;
	answer(close: boolean): void;
}

export const useCloseQuestion = create<{ asking: Question | null }>(() => ({ asking: null }));

/** Shells some pane in this window is showing right now, counted: two panes can show one shell. */
const shown = new Map<string, number>();

export function showing(id: string): () => void {
	shown.set(id, (shown.get(id) ?? 0) + 1);
	return () => {
		const left = (shown.get(id) ?? 1) - 1;
		if (left > 0) shown.set(id, left);
		else shown.delete(id);
	};
}

/** Resolves `true` to go ahead with closing, `false` to keep the terminal. */
export function confirmCloseTerminal(scope: string, kind: string): Promise<boolean> {
	const slot = terminalSlot(scope, panelInstance(kind))!;
	const id = useTerminals.getState().activeByScope[slot] || savedTerminal(slot);
	const process = id ? useTerminals.getState().tabs.find((tab) => tab.id === id)?.process : null;
	if (!id || !process || !shown.has(id)) return Promise.resolve(true);
	return new Promise((resolve) => {
		// 上一个问题还没答又来一个：上一个算「不关」，免得它的 await 永远停在那儿。
		useCloseQuestion.getState().asking?.answer(false);
		useCloseQuestion.setState({
			asking: {
				id,
				process,
				answer: (close) => {
					if (useCloseQuestion.getState().asking?.id === id) useCloseQuestion.setState({ asking: null });
					resolve(close);
				},
			},
		});
	});
}
