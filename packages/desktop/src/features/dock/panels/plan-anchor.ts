/**
 * 计划面板里划下的那段字：存成字符位置，画成高亮。
 *
 * 存位置不存 `Range`：`Range` 挂在具体的文字节点上，面板切走再回来、正文重画一次就指向了不存在的
 * 节点。位置按正文所有文字节点连起来数，和 `Range.toString()` 同一种数法，所以来回能对上。
 *
 * 高亮用 CSS Custom Highlight，不往 Markdown 里插 `<mark>`：插了就改了 `Markdown` 画出来的 DOM，
 * 下一次重画要么把标记冲掉，要么和它打架。样式名是全局的，两块屏各开一个计划面板时得合在一起登记，
 * 见 `paint`。
 */

/** `node` 里第 `offset` 个位置，在 `root` 的全部文字里是第几个字符。 */
export function offsetIn(root: Node, node: Node, offset: number): number {
	const range = document.createRange();
	range.setStart(root, 0);
	range.setEnd(node, offset);
	return range.toString().length;
}

/** 反过来：`root` 里 [start, end) 这段字的 `Range`。位置已经不在正文里时为 null。 */
export function rangeIn(root: Node, start: number, end: number): Range | null {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const range = document.createRange();
	let seen = 0;
	let started = false;
	for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
		const next = seen + node.length;
		if (!started && start < next) {
			range.setStart(node, start - seen);
			started = true;
		}
		if (started && end <= next) {
			range.setEnd(node, end - seen);
			return range;
		}
		seen = next;
	}
	return null;
}

/** 已经留了评论的段落，和正在写评论的那一段。名字和 `base.css` 里的 `::highlight()` 对应。 */
export type PlanMark = "ly-plan-comment" | "ly-plan-draft";

const sources: Record<PlanMark, Map<symbol, Range[]>> = { "ly-plan-comment": new Map(), "ly-plan-draft": new Map() };

/** 这块面板这一种高亮画哪些段；给空数组就是撤掉它的。 */
export function paint(owner: symbol, mark: PlanMark, ranges: Range[]): void {
	// 没有这套 API 的环境（测试里的 DOM）只是不画，评论照样记。
	if (typeof CSS === "undefined" || !("highlights" in CSS) || typeof Highlight === "undefined") return;
	if (ranges.length) sources[mark].set(owner, ranges);
	else sources[mark].delete(owner);
	const all = [...sources[mark].values()].flat();
	if (all.length) CSS.highlights.set(mark, new Highlight(...all));
	else CSS.highlights.delete(mark);
}
