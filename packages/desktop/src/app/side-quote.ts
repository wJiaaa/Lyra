/**
 * 把对话里划下的一段放进这个会话旁边的侧边聊天输入框——`QuoteMenu` 的「在侧边聊天中提问」。
 *
 * 由 dock 注册，理由同 `file-opener.ts`：菜单长在对话里，dock 画着对话，从对话引 dock 会连成环。
 */
let quoter: ((sessionId: string, text: string) => void) | null = null;

export function provideSideQuote(quote: typeof quoter): void {
	quoter = quote;
}

export function quoteInSideChat(sessionId: string, text: string): void {
	quoter?.(sessionId, text);
}
