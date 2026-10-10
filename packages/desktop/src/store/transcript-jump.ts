import { create } from "zustand";

/**
 * 有人要转录滚到某一问——从对话以外的地方，比如环境卡片里的「第 N 轮」。
 *
 * 和 `job-focus.ts` 同一个形状：是一次请求，不是一个选中态。`index` 是那条用户消息在
 * `intact(messages)` 里的下标，和问题导航用的是同一个数，转录据此翻窗口、滚过去，然后把它清掉。
 */
export const useTranscriptJump = create<{ jump: { sessionId: string; index: number; at: number } | null }>(() => ({ jump: null }));

export function jumpToMessage(sessionId: string, index: number): void {
	useTranscriptJump.setState({ jump: { sessionId, index, at: Date.now() } });
}

export function clearTranscriptJump(): void {
	useTranscriptJump.setState({ jump: null });
}
