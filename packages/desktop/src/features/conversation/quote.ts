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
	// 单个字拿去问说明不了什么，多半是点字时手抖带出来的选区，不值得弹一条菜单盖在正文上。按码位数，emoji 算一个。
	if ([...text].length < 2) return null;
	// 两处挂点各自写明是谁的话：`rows.tsx` 是回复，`UserMessage.tsx` 是人问的。
	return { text, range: selectedText(range), from: start.getAttribute("data-ly-quote") === "user" ? "user" : "assistant" };
}

/**
 * 选区收到人真正看见被选中的字上：起点挪到第一段选中的字，终点挪到最后一段。
 *
 * 划词菜单拿这个范围量挂点。三击选段时浏览器把终点放在下一段开头，下一段若是代码块，`user-select:
 * none` 的标题栏被跳过、整个落进选区，`getBoundingClientRect()` 把它整栏宽的边框盒也并进来——菜单
 * 就对着栏中间，而不是那行字。
 */
export function selectedText(range: Range): Range {
	const root = range.commonAncestorContainer;
	if (root.nodeType === Node.TEXT_NODE) return range.cloneRange();
	const walker = root.ownerDocument!.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	let first: Text | null = null;
	let last: Text | null = null;
	for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
		if (!range.intersectsNode(node) || !chosen(node, range)) continue;
		first ??= node;
		last = node;
	}
	if (!first || !last) return range.cloneRange();
	const trimmed = range.cloneRange();
	trimmed.setStart(first, first === range.startContainer ? range.startOffset : 0);
	trimmed.setEnd(last, last === range.endContainer ? range.endOffset : last.length);
	return trimmed;
}

/** 这段字在选区里有没有选中的可见内容：只选到一个换行、或者标题栏那种选不中的字，都不算。 */
function chosen(node: Text, range: Range): boolean {
	const from = node === range.startContainer ? range.startOffset : 0;
	const to = node === range.endContainer ? range.endOffset : node.length;
	if (!node.data.slice(from, to).trim()) return false;
	const parent = node.parentElement;
	return !parent || getComputedStyle(parent).userSelect !== "none";
}

function holder(node: Node): Element | null {
	return (node instanceof Element ? node : node.parentElement)?.closest("[data-ly-quote]") ?? null;
}
