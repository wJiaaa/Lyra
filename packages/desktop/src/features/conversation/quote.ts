/**
 * 对话里划下的一段，怎么认、怎么写进输入框。
 *
 * 只认落在同一条消息里的选区（`[data-ly-quote]`，见 `rows.tsx` 和 `UserMessage.tsx`）。跨了消息的
 * 那种，拖出来的除了两边的字，还有夹在中间的时间、「调用工具 N 个」、按钮上的字——拿去问，模型看到
 * 的是一段界面，不是谁说过的话。
 */

/** 选区在哪一条消息里；不在消息里、或者跨了消息，为 null。 */
export function quotedIn(selection: Selection | null, within: HTMLElement): { text: string; range: Range } | null {
	if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
	const range = selection.getRangeAt(0);
	const start = holder(range.startContainer);
	if (!start || start !== holder(range.endContainer) || !within.contains(start)) return null;
	const text = selection.toString().trim();
	return text ? { text, range: range.cloneRange() } : null;
}

function holder(node: Node): Element | null {
	return (node instanceof Element ? node : node.parentElement)?.closest("[data-ly-quote]") ?? null;
}

/**
 * 写成 Markdown 引用块，后面空一行留给要说的话。
 *
 * 空一行不能省：紧跟在 `> …` 下面的一行在 Markdown 里会被并进引用，问题就成了引文的一部分。
 */
export function quoteBlock(text: string): string {
	const lines = text.replace(/\r\n?/g, "\n").trim().split("\n");
	return `${lines.map((line) => (line.trim() ? `> ${line}` : ">")).join("\n")}\n\n`;
}
