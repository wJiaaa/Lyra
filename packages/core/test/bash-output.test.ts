import assert from "node:assert/strict";
import { test } from "node:test";
import { clipOutput, OutputBuffer } from "../src/tools/bash-output.ts";

const MAX = 60_000;

/** 一个像真实构建那样滚动输出的命令：大量普通行，中间零星几条错误。 */
function build(lines: number): string[] {
	const out: string[] = [];
	for (let i = 1; i <= lines; i++) out.push(i % 2500 === 0 ? `Error: failure number ${i / 2500}` : `compiling module ${i} ok`);
	return out;
}

function omittedOf(text: string): { chars: number; from: number; to: number }[] {
	return [...text.matchAll(/\[(\d+) characters omitted, lines? (\d+)(?:-(\d+))?/g)].map((m) => ({ chars: Number(m[1]), from: Number(m[2]), to: Number(m[3] ?? m[2]) }));
}

test("output streamed in chunks is clipped once, with one marker and each error at most once", () => {
	const lines = build(20_000);
	const raw = `${lines.join("\n")}\n`;
	const buffer = new OutputBuffer();
	// 每段 64 字符，模拟一行一行吐出来——以前每段都对上一次的结果再截一次。
	for (let at = 0; at < raw.length; at += 64) {
		buffer.append(raw.slice(at, at + 64));
		if (at % 6400 === 0) buffer.render(MAX);
	}
	const text = buffer.render(MAX);
	assert.ok(text.length <= MAX, `${text.length}`);
	const markers = omittedOf(text);
	assert.equal(markers.length, 1, "只截一次，只有一个省略标记");
	for (let n = 1; n <= 8; n++) {
		const count = text.split(`failure number ${n}\n`).length - 1 + (text.endsWith(`failure number ${n}`) ? 1 : 0);
		assert.ok(count <= 1, `错误 ${n} 出现了 ${count} 次`);
	}
	assert.match(text, /failure number 1\b/);
	assert.match(text, /failure number 5\b/, "后面的错误不能被第一条挤掉");
	// 省略的字符数是真实数目：显示出来的原文行 + 省略数 = 原始总长。
	const [{ chars, from, to }] = markers;
	const shownLines = text.split("\n").filter((line) => /^compiling module \d+ ok$|^Error: failure number \d+$/.test(line));
	assert.ok(chars > 400_000, `省略了 ${chars}`);
	assert.equal(lines[from - 1] !== undefined && lines[to - 1] !== undefined, true);
	const head = lines.slice(0, from - 1);
	const tail = lines.slice(to);
	// 头部每行带着它后面的换行；尾部是「\n」+ 这些行 + 末尾那个换行。
	const shown = head.join("\n").length + 1 + tail.join("\n").length + 2;
	assert.equal(chars, raw.length - shown, "省略数与原文对得上");
	assert.ok(shownLines.length > 0);
});

test("below the memory bound, streamed and one-shot clipping are identical", () => {
	const raw = build(3_000).join("\n");
	const buffer = new OutputBuffer();
	for (let at = 0; at < raw.length; at += 100) buffer.append(raw.slice(at, at + 100));
	assert.equal(buffer.render(MAX), clipOutput(raw, MAX));
	const small = new OutputBuffer();
	small.append("a\n");
	small.append("b");
	assert.equal(small.render(MAX), "a\nb", "放得下就原样");
	assert.equal(small.clipped(MAX), false);
});

test("the omitted range names real lines of the full log, counted from where reading resumed", () => {
	const buffer = new OutputBuffer({ line: 101, column: 0 });
	const lines = Array.from({ length: 5_000 }, (_, i) => `row ${i + 101}`);
	buffer.append(lines.join("\n"));
	const [marker] = omittedOf(buffer.render(2_000));
	const text = buffer.render(2_000);
	// 省略范围前一行和后一行都显示着。
	assert.match(text, new RegExp(`row ${marker.from - 1}\\n`));
	assert.match(text, new RegExp(`\\nrow ${marker.to + 1}\\n`));
	assert.ok(!text.includes(`row ${marker.from}\n`));
	assert.equal(buffer.end.line, 101 + 4_999);
});

test("a single huge line keeps head and tail with a readable line and char_offset", () => {
	const buffer = new OutputBuffer();
	buffer.append("x".repeat(500_000));
	buffer.append("TAIL");
	const text = buffer.render(MAX);
	assert.ok(text.length < 10_000, `${text.length}`);
	assert.match(text, /line 1 char_offset=\d+/);
	assert.match(text, /TAIL$/);
	assert.ok(buffer.clipped(MAX));
});
