/**
 * 一段 markdown 按顶层块切开的原文，每块单独渲染、原文没变就不重画——照桌面 `parseMarkdownChunks`。
 *
 * 手机用的 markdown 库每解析一次都给每个节点一个新 key（`getUniqueID` 是自增的），整段一起渲染时，
 * 流式输出每来一批字，前面所有段落、列表、代码块的原生视图都被拆掉重建一遍。切开之后每帧重建的只有
 * 正在写的最后一块。
 *
 * 切点取 markdown-it 顶层块的起始行，所以列表、引用、围栏代码都整块留在一起，不会被拆成两半。
 */

/** 引用式链接的定义：`[1]: https://…`。定义和引用可能落在不同的块里，有它就不切。 */
const REFERENCE = /^ {0,3}\[[^\]]+\]:/m;

export interface BlockToken { level: number; nesting: number; map: [number, number] | null }

export function splitBlocks(source: string, tokens: readonly BlockToken[]): string[] {
	if (REFERENCE.test(source)) return [source];
	const lines = source.split("\n");
	const starts = [...new Set(tokens.filter((token) => token.level === 0 && token.nesting !== -1 && token.map && token.map[0] > 0).map((token) => token.map![0]))].sort((a, b) => a - b);
	const chunks: string[] = [];
	let from = 0;
	for (const start of starts) {
		chunks.push(lines.slice(from, start).join("\n"));
		from = start;
	}
	chunks.push(lines.slice(from).join("\n"));
	return chunks;
}
