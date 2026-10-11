import assert from "node:assert/strict";
import { test } from "node:test";

import { quoteBlock, withQuotes } from "../src/lib/quote.ts";

test("划下的一段写成引用块，后面空一行，问题不会被并进引用", () => {
	assert.equal(quoteBlock("这里为什么用 rAF"), "> 这里为什么用 rAF\n\n");
});

test("多行逐行加引用符，段落之间的空行留成单独的 >，首尾空白去掉", () => {
	assert.equal(quoteBlock("\n第一段\r\n\r\n第二段\n  "), "> 第一段\n>\n> 第二段\n\n");
});

test("发出去时引文按先后排在要说的话前面，一段一个引用块", () => {
	const quotes = [{ id: "a", text: "第一段", from: "assistant" as const }, { id: "b", text: "第二段", from: "user" as const }];
	assert.equal(withQuotes("为什么", quotes), "> 第一段\n\n> 第二段\n\n为什么");
});

test("只有引文没说话时，不留末尾空行；没有引文时原样返回", () => {
	assert.equal(withQuotes("", [{ id: "a", text: "第一段", from: "assistant" }]), "> 第一段");
	assert.equal(withQuotes("为什么", []), "为什么");
});
