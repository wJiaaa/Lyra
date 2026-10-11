/**
 * 对话里划下的一段，怎么认。
 *
 * 只认落在同一条消息里的选区（`[data-ly-quote]`，见 `rows.tsx` 和 `UserMessage.tsx`）。跨了消息的
 * 那种，拖出来的除了两边的字，还有夹在中间的时间、「调用工具 N 个」、按钮上的字——拿去问，模型看到
 * 的是一段界面，不是谁说过的话。
 */

/** 选区在哪一条消息里；不在消息里、或者跨了消息，为 null。 */
export function quotedIn(selection: Selection | null, within: HTMLElement): { text: string; range: Range; from: "user" | "assistant" } | null {
	if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
	const range = selection.getRangeAt(0);
	const start = holder(range.startContainer);
	if (!start || start !== holder(range.endContainer) || !within.contains(start)) return null;
	const text = selection.toString().trim();
	if (!text) return null;
	// 两处挂点各自写明是谁的话：`rows.tsx` 是回复，`UserMessage.tsx` 是人问的。
	return { text, range: range.cloneRange(), from: start.getAttribute("data-ly-quote") === "user" ? "user" : "assistant" };
}

function holder(node: Node): Element | null {
	return (node instanceof Element ? node : node.parentElement)?.closest("[data-ly-quote]") ?? null;
}
