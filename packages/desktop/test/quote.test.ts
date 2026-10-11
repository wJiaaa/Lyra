import assert from "node:assert/strict";
import { test } from "node:test";

import { quoteBlock } from "../src/features/conversation/quote.ts";

test("划下的一段写成引用块，后面空一行，问题不会被并进引用", () => {
	assert.equal(quoteBlock("这里为什么用 rAF"), "> 这里为什么用 rAF\n\n");
});

test("多行逐行加引用符，段落之间的空行留成单独的 >，首尾空白去掉", () => {
	assert.equal(quoteBlock("\n第一段\r\n\r\n第二段\n  "), "> 第一段\n>\n> 第二段\n\n");
});
