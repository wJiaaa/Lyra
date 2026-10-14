/**
 * 划词菜单量挂点用的范围，只包住真正选中的字。
 *
 * 三击选中代码块前面那一段时，浏览器把终点放进代码块里、跳过 `user-select: none` 的标题栏——
 * 标题栏于是整个落进选区，它整栏宽的边框盒把菜单推到了栏中间。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { quotedIn, selectedText } from "../../src/features/conversation/quote.ts";

/** 范围两端落在哪段字的第几个字上；比字符串而不是节点，断言失败时不去打印整棵 DOM。 */
function ends(range: Range): string {
	return `${range.startContainer.textContent}@${range.startOffset} → ${range.endContainer.textContent}@${range.endOffset}`;
}

function reply(): { para: Text; pre: HTMLElement; before: Text } {
	document.body.innerHTML = `<div data-ly-quote="assistant"><p>2*2 = 4</p><p>在 tty 里实测：</p><div class="ly-code-block"><div style="user-select: none">python</div><pre><code>&gt;&gt;&gt; 1</code></pre></div></div>`;
	const [before, para] = [...document.querySelectorAll("p")].map((p) => p.firstChild as Text);
	return { para: para!, pre: document.querySelector("pre")!, before: before! };
}

test("三击选段：终点从代码块里收回到这一段的末尾，标题栏不在范围里", () => {
	const { para, pre } = reply();
	const range = document.createRange();
	range.setStart(para, 0);
	range.setEnd(pre, 0);
	assert.equal(ends(selectedText(range)), `在 tty 里实测：@0 → 在 tty 里实测：@${para.length}`);
});

test("从上一段末尾拖起：起点挪到这一段的第一个字", () => {
	const { para, before } = reply();
	const range = document.createRange();
	range.setStart(before, before.length);
	range.setEnd(para, 3);
	assert.equal(ends(selectedText(range)), "在 tty 里实测：@0 → 在 tty 里实测：@3");
});

test("段内拖选原样保留", () => {
	const { para } = reply();
	const range = document.createRange();
	range.setStart(para, 2);
	range.setEnd(para, 5);
	assert.equal(ends(selectedText(range)), "在 tty 里实测：@2 → 在 tty 里实测：@5");
});

/** 在这一段里从 `from` 选到 `to`，交给 `quotedIn` 认。 */
function pick(from: number, to: number) {
	const { para } = reply();
	const range = document.createRange();
	range.setStart(para, from);
	range.setEnd(para, to);
	const selection = window.getSelection()!;
	selection.removeAllRanges();
	selection.addRange(range);
	return quotedIn(selection, document.body);
}

test("只选中一个字不算一段引文，菜单不弹；带上旁边的空格也还是一个字", () => {
	assert.equal(pick(0, 1), null);
	assert.equal(pick(0, 2), null);
});

test("两个字起就认", () => {
	assert.equal(pick(6, 8)?.text, "里实");
	assert.equal(pick(2, 5)?.text, "tty");
});
