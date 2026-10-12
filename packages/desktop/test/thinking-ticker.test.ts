/**
 * How much of a reasoning still being written the open body keeps on screen.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { thinkingTail } from "../src/features/conversation/thinking-ticker.ts";

test("a short reasoning is shown whole", () => {
	assert.deepEqual(thinkingTail("short", 100), { tail: "short", hidden: 0 });
});

test("a long reasoning keeps only its end, never more than the limit", () => {
	const text = "x".repeat(50_000);
	const { tail, hidden } = thinkingTail(text, 16_000);
	assert.ok(tail.length <= 16_000);
	assert.equal(hidden + tail.length, text.length);
	assert.equal(text.slice(hidden), tail);
});

test("the tail's start holds still while a few characters arrive", () => {
	const text = "y".repeat(30_001);
	assert.equal(thinkingTail(text, 16_000).hidden, thinkingTail(`${text}more`, 16_000).hidden);
});

test("the tail opens on a line of its own when a break is near", () => {
	// The step lands at 24 000, ten characters before the break: the window starts after it.
	const text = `${"a".repeat(24_010)}\n${"b".repeat(12_000)}`;
	assert.equal(thinkingTail(text, 16_000).tail, "b".repeat(12_000));
});
