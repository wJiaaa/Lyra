/**
 * The line diff behind edit previews, approval prompts and the review panes.
 *
 * Its table grows as (changed old lines) × (changed new lines). Unbounded, a 6000-line file whose
 * every line differed — a CRLF checkout diffed against its LF blob — took most of a second and a few
 * hundred megabytes to report that every line changed. Past a ceiling the middle is now shown as one
 * block replaced: still a correct diff, only not the smallest.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { computeDiff } from "../src/tools/diff.ts";

const lines = (n: number, line: (i: number) => string) => `${Array.from({ length: n }, (_, i) => line(i)).join("\n")}\n`;

test("上限以内仍是最小改动：两边共有的行对齐成上下文", () => {
	const before = `${lines(100, (i) => `old ${i}`)}common\n`;
	const after = `common\n${lines(100, (i) => `new ${i}`)}`;
	const diff = computeDiff(before, after);
	assert.deepEqual([diff.removed, diff.added], [100, 100]);
	assert.ok(diff.hunks.some((hunk) => hunk.lines.some((line) => line.type === "context" && line.text === "common")));
});

test("改动区超过上限：整块替换，不再为对齐一行去建几百万格的表", () => {
	// 2002 × 2002 lines of middle, just past the ceiling: the one shared line is no longer aligned.
	const before = `${lines(2001, (i) => `old ${i}`)}common\n`;
	const after = `common\n${lines(2001, (i) => `new ${i}`)}`;
	const diff = computeDiff(before, after);
	assert.deepEqual([diff.removed, diff.added], [2002, 2002]);
});

test("6000 行每行都不同：很快给出答案", () => {
	const before = lines(6000, (i) => `line ${i}`);
	const after = lines(6000, (i) => `line ${i}\r`);
	const started = performance.now();
	const diff = computeDiff(before, after);
	const elapsed = performance.now() - started;
	assert.deepEqual([diff.removed, diff.added], [6000, 6000]);
	// Unbounded this took 934ms on the machine it was measured on; bounded, a few milliseconds.
	assert.ok(elapsed < 400, `用了 ${elapsed.toFixed(0)}ms`);
});

test("整块替换时，前后公共部分的行号照旧连续", () => {
	const before = `head\n${lines(2001, (i) => `old ${i}`)}tail\n`;
	const after = `head\n${lines(2001, (i) => `new ${i}`)}tail\n`;
	const { hunks } = computeDiff(before, after, 1);
	const first = hunks[0]?.lines ?? [];
	const last = hunks[hunks.length - 1]?.lines ?? [];
	assert.deepEqual(first[0], { type: "context", text: "head", oldLine: 1, newLine: 1 });
	assert.deepEqual(last[last.length - 1], { type: "context", text: "tail", oldLine: 2003, newLine: 2003 });
});

test("diff reconstructs both files with accurate line numbers across inserts, deletes and repeats", () => {
	const samples = ["", "a", "b", "a\nb", "b\na", "a\na\nb", "b\na\na", "a\nb\nc\na"];
	for (const before of samples) for (const after of samples) {
		const diff = computeDiff(before, after, 100);
		if (before === after) { assert.deepEqual(diff, { added: 0, removed: 0, hunks: [] }); continue; }
		const lines = diff.hunks.flatMap((hunk) => hunk.lines);
		const old = lines.filter((line) => line.type !== "add"), next = lines.filter((line) => line.type !== "remove");
		assert.equal(old.map((line) => line.text).join("\n"), before);
		assert.equal(next.map((line) => line.text).join("\n"), after);
		assert.deepEqual(old.map((line) => line.oldLine), old.map((_, i) => i + 1));
		assert.deepEqual(next.map((line) => line.newLine), next.map((_, i) => i + 1));
		assert.equal(diff.added, next.length - lines.filter((line) => line.type === "context").length);
		assert.equal(diff.removed, old.length - lines.filter((line) => line.type === "context").length);
	}
});

test("small diffs use the minimum number of edits, including repeated lines", () => {
	const samples = Array.from({ length: 63 }, (_, n) => (n + 1).toString(2).slice(1).split("").map((bit) => bit === "0" ? "a" : "b"));
	for (const a of samples) for (const b of samples) {
		const lengths = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0));
		for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
			lengths[i][j] = a[i - 1] === b[j - 1] ? lengths[i - 1][j - 1] + 1 : Math.max(lengths[i - 1][j], lengths[i][j - 1]);
		}
		const result = computeDiff(a.join("\n"), b.join("\n"));
		assert.equal(result.added + result.removed, a.length + b.length - 2 * lengths[a.length][b.length]);
	}
});

test("two distant changes in a large file fit in a bounded heap and stay two changes", () => {
	const module = new URL("../src/tools/diff.ts", import.meta.url).href;
	const output = execFileSync(process.execPath, ["--max-old-space-size=128", "--experimental-strip-types", "--input-type=module", "-e", `
		import { computeDiff } from ${JSON.stringify(module)};
		const lines = Array.from({length: 20000}, (_, i) => "line " + i);
		const before = lines.join("\\n"); lines[0] = "first"; lines[19999] = "last";
		const result = computeDiff(before, lines.join("\\n"));
		process.stdout.write(JSON.stringify({added:result.added, removed:result.removed, hunks:result.hunks.length}));
	`], { timeout: 10000, encoding: "utf8", maxBuffer: 10000 });
	assert.deepEqual(JSON.parse(output), { added: 2, removed: 2, hunks: 2 });
});

test("a large rewrite still produces a complete diff when the search budget is exhausted", () => {
	const before = Array.from({ length: 1200 }, (_, i) => `old ${i}`), after = before.map((_, i) => `new ${i}`);
	const result = computeDiff(before.join("\n"), after.join("\n"));
	assert.equal(result.removed, before.length); assert.equal(result.added, after.length);
	const lines = result.hunks.flatMap((h) => h.lines);
	assert.deepEqual(lines.filter((l) => l.type !== "add").map((l) => l.text), before);
	assert.deepEqual(lines.filter((l) => l.type !== "remove").map((l) => l.text), after);
});
