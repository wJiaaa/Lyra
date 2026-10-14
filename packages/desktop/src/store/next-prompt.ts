/**
 * 每个对话最近一次猜的下一句（core 的 `next_prompt` 事件），输入框空着时当灰字显示，Tab 填入。
 *
 * 按会话 id 记，不跟着屏上那个走：分屏时两个输入框各看各的，没在看的对话收尾时猜的那句，切过去
 * 也还在。下一轮开始、历史被撤回时丢掉——那时它说的已经不是眼前这段对话了。不落盘，重开应用就没了。
 */

import { create } from "zustand";
import type { AgentEvent } from "@plume/core";

interface NextPromptState {
	bySession: Record<string, string>;
}

export const useNextPrompt = create<NextPromptState>(() => ({ bySession: {} }));

export function noteNextPrompt(sessionId: string, event: AgentEvent): void {
	const { bySession } = useNextPrompt.getState();
	if (event.type === "next_prompt") {
		useNextPrompt.setState({ bySession: { ...bySession, [sessionId]: event.text } });
	} else if ((event.type === "agent_start" || event.type === "rewound") && sessionId in bySession) {
		const { [sessionId]: _dropped, ...rest } = bySession;
		useNextPrompt.setState({ bySession: rest });
	}
}
