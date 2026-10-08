import assert from "node:assert/strict";
import { test } from "node:test";
import { splitBlocks, type BlockToken } from "../src/markdown-chunks.ts";

// markdown-it 给出的顶层 token（只留切块要看的三项）：开、闭标签各一个，里面的 inline 层级更深。
const block = (start: number, end: number): BlockToken[] => [{ level: 0, nesting: 1, map: [start, end] }, { level: 1, nesting: 0, map: [start, end] }, { level: 0, nesting: -1, map: null }];

test("按顶层块的起始行切开，块之间的空行跟着前一块，拼回去还是原文", () => {
	const source = "## 改好了\n\n手机端做了三件事：\n\n- 读了文件\n- 加了一行\n\n有问题随时说。";
	const tokens = [...block(0, 1), ...block(2, 3), { level: 0, nesting: 1, map: [4, 6] as [number, number] }, { level: 1, nesting: 1, map: [4, 5] as [number, number] }, { level: 1, nesting: 1, map: [5, 6] as [number, number] }, { level: 0, nesting: -1, map: null }, ...block(7, 8)];
	const chunks = splitBlocks(source, tokens);
	assert.deepEqual(chunks, ["## 改好了\n", "手机端做了三件事：\n", "- 读了文件\n- 加了一行\n", "有问题随时说。"]);
	assert.equal(chunks.join("\n"), source);
});

test("列表项里面的段落层级更深，不会把一个列表切成两半", () => {
	const tokens: BlockToken[] = [{ level: 0, nesting: 1, map: [0, 3] }, { level: 2, nesting: 1, map: [0, 1] }, { level: 2, nesting: 1, map: [2, 3] }, { level: 0, nesting: -1, map: null }];
	assert.deepEqual(splitBlocks("- 一\n\n- 二", tokens), ["- 一\n\n- 二"]);
});

test("有引用式链接的定义时不切：定义和引用可能落在两块里", () => {
	const source = "见 [文档][1]。\n\n[1]: https://example.com";
	assert.deepEqual(splitBlocks(source, block(0, 1)), [source]);
});
