/**
 * `edit` when `old_string` is not in the file byte for byte: the near readings ported from ZCode.
 *
 * Each reading is a way models really copy text wrong. What must hold for all of them: one distinct
 * near text is replaced, several are refused rather than guessed, and `new_string` lands in the
 * file's own form — its quotes, no line-number prefixes, no written-out escapes.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findEditMatch } from "../src/tools/edit-match.ts";
import { editTool } from "../src/tools/edit.ts";
import { readTool } from "../src/tools/read.ts";
import type { ToolContext, ToolResult } from "../src/types.ts";

const textOf = (result: ToolResult) => result.content.map((part) => (part.type === "text" ? part.text : "")).join("");

async function edited(t: { after(fn: () => Promise<void>): void }, content: string, oldString: string, newString: string) {
	const dir = await mkdtemp(join(tmpdir(), "plume-edit-match-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const file = join(dir, "sample.txt");
	await writeFile(file, content, "utf8");
	const ctx: ToolContext = { cwd: dir, sessionId: "t", state: new Map() };
	await readTool.execute({ path: file } as never, ctx);
	const result = await editTool.execute({ path: file, old_string: oldString, new_string: newString }, ctx);
	return { result, text: await readFile(file, "utf8"), file, ctx };
}

test("line-number prefixes copied from read are dropped from both sides", async (t) => {
	const { result, text } = await edited(t, "alpha\nbravo\ncharlie\n", "2→bravo\n3→charlie", "2→BRAVO\n3→CHARLIE");
	assert.equal(result.isError, undefined, textOf(result));
	assert.equal(text, "alpha\nBRAVO\nCHARLIE\n");
});

test("straight quotes find curly ones, and the replacement keeps the file's curly quotes", async (t) => {
	const { result, text } = await edited(t, "She said “hello” and left.\n", 'said "hello"', 'said "goodbye"');
	assert.equal(result.isError, undefined, textOf(result));
	assert.equal(text, "She said “goodbye” and left.\n");
});

test("escapes written out in old_string match the real characters", async (t) => {
	const { result, text } = await edited(t, "a\tb\n", "a\\tb", "a\\tc");
	assert.equal(result.isError, undefined, textOf(result));
	assert.equal(text, "a\tc\n");
});

test("trailing spaces on a line do not stop a match, and its newline is replaced, not doubled", async (t) => {
	const { result, text } = await edited(t, "one  \ntwo\nthree\n", "one\ntwo\n", "ONE\nTWO\n");
	assert.equal(result.isError, undefined, textOf(result));
	assert.equal(text, "ONE\nTWO\nthree\n");
});

test("a block at another indent is found", () => {
	const match = findEditMatch("\tif (x) {\n\t\ty();\n\t}\n", "if (x) {\n\ty();\n}", false);
	assert.deepEqual(match, { status: "matched", actual: "\tif (x) {\n\t\ty();\n\t}", strategy: "line_trimmed" });
});

test("a block whose first and last lines match and whose middle is close is found", () => {
	const content = "function f() {\n\tconst total = a + b;\n\treturn total;\n}\n";
	const match = findEditMatch(content, "function f() {\n\tconst total = a+b;\n\treturn total;\n}", false);
	assert.equal(match.status, "matched");
	assert.equal(match.status === "matched" && match.strategy, "block_anchor");
});

test("two different near texts are refused rather than guessed", async (t) => {
	const { result, text } = await edited(t, "x = 1  \ny = 2\n\nx = 1\t\ny = 2\n", "x = 1\ny = 2", "z");
	assert.equal(result.isError, true);
	assert.match(textOf(result), /come close/);
	assert.equal(text, "x = 1  \ny = 2\n\nx = 1\t\ny = 2\n");
});

test("replace_all does not use the line-shape readings", () => {
	assert.deepEqual(findEditMatch("one  \ntwo\n", "one\ntwo", true), { status: "not_found" });
});

test("text that is nowhere near stays not found", () => {
	assert.deepEqual(findEditMatch("alpha\nbravo\n", "charlie", false), { status: "not_found" });
});

test("a later modification time is a change even at the same size", async (t) => {
	const { file, ctx } = await edited(t, "alpha\n", "alpha", "bravo");
	await writeFile(file, "ALPHA\n", "utf8");
	const later = new Date(Date.now() + 5_000);
	await utimes(file, later, later);
	const result = await editTool.execute({ path: file, old_string: "ALPHA", new_string: "x" }, ctx);
	assert.equal(result.isError, true);
	assert.match(textOf(result), /changed since you read it/);
});
