/**
 * A tool result is judged by its total, and has to come back inside that total.
 *
 * MCP tools answer with several text blocks. Cutting each block against the whole threshold let a
 * result of ten 8,000-character blocks — 80,000 characters — through untouched, because no single
 * block was over the line.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { PRUNE_THRESHOLD_CHARS, pruneToolResults } from "../src/runtime/prune.ts";
import type { Message, ToolResultMessage } from "../src/types.ts";

function result(...texts: string[]): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "c1",
		toolName: "mcp",
		content: texts.map((text) => ({ type: "text" as const, text })),
		isError: false,
		timestamp: 0,
	};
}

const size = (message: Message) => message.content.reduce((sum, block) => sum + (block.type === "text" ? [...block.text].length : 0), 0);

test("ten blocks under the threshold each are still cut to the threshold together", () => {
	const message = result(...Array.from({ length: 10 }, (_, i) => String(i).repeat(8000)));
	const [cut] = pruneToolResults([message]);
	assert.notEqual(cut, message, "something was cut");
	assert.ok(size(cut) <= PRUNE_THRESHOLD_CHARS, `the whole result fits the threshold: ${size(cut)}`);
	assert.equal(cut.content.length, 10, "every block is still there");
	for (let i = 0; i < 10; i++) {
		const text = (cut.content[i] as { text: string }).text;
		assert.ok(text.startsWith(String(i)) && text.endsWith(String(i)), "each keeps its own head and tail");
	}
	assert.equal(pruneToolResults([cut])[0], cut, "and a second pass finds nothing to do");
});

test("a small block beside a huge one is left exactly as it was", () => {
	const small = "s".repeat(600);
	const huge = "h".repeat(60_000);
	const [cut] = pruneToolResults([result(small, huge)]);
	assert.equal((cut.content[0] as { text: string }).text, small);
	const [alone] = pruneToolResults([result(huge)]);
	assert.equal((cut.content[1] as { text: string }).text, (alone.content[0] as { text: string }).text, "the huge block is cut as it would be on its own");
	assert.ok(size(cut) <= PRUNE_THRESHOLD_CHARS);
});

test("only the blocks that are cut are stored, and stored whole", () => {
	const kept: string[] = [];
	const sink = { keep: (_tool: string, content: string) => (kept.push(content), `artifact://a${kept.length}`) };
	const small = "s".repeat(300);
	const big = ["a".repeat(20_000), "b".repeat(20_000)];
	const [cut] = pruneToolResults([result(small, ...big)], undefined, sink);
	assert.deepEqual(kept, big, "the originals of the two cut blocks, nothing else");
	assert.match((cut.content[1] as { text: string }).text, /artifact:\/\/a1/);
	assert.match((cut.content[2] as { text: string }).text, /artifact:\/\/a2/);
	assert.ok(size(cut) <= PRUNE_THRESHOLD_CHARS);
});

test("too many blocks for a marker each are cut as one", () => {
	const kept: string[] = [];
	const sink = { keep: (_tool: string, content: string) => (kept.push(content), `artifact://a${kept.length}`) };
	const message = result(...Array.from({ length: 100 }, (_, i) => `${i}:${"x".repeat(8000)}`));
	const [cut] = pruneToolResults([message], undefined, sink);
	assert.ok(size(cut) <= PRUNE_THRESHOLD_CHARS, `fits: ${size(cut)}`);
	assert.equal(kept.length, 1, "one address for the whole result");
	assert.ok(kept[0].startsWith("0:") && kept[0].includes("99:"), "and it holds every block");
	assert.equal(pruneToolResults([cut])[0], cut);
});
