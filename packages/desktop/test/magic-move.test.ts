/**
 * Pairing the words of one language's sample with another's.
 *
 * The whole of the switching animation rests on this: pairs travel, everything else fades. Pair
 * the wrong things and the screen fills with words crossing each other's paths, which reads as
 * noise rather than as one program becoming another.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { pairWords, travels } from "../src/features/settings/magic-move.ts";

const stream = (...texts: string[]) => texts.map((text) => ({ text }));

test("the same word in both streams is paired", () => {
	const pairs = pairWords(stream("func", " ", "Counter"), stream("function", " ", "Counter"));
	// `Counter` is at 2 in both; `func`/`function` are different words.
	assert.deepEqual([...pairs], [[2, 2]]);
});

test("repeats pair first-to-first, so the paths stay parallel", () => {
	const before = stream("count", "x", "count", "y", "count");
	const after = stream("z", "count", "w", "count", "v", "count");
	assert.deepEqual(
		[...pairWords(before, after)],
		[
			[1, 0],
			[3, 2],
			[5, 4],
		],
		"first with first, second with second — not nearest, which would cross them",
	);
});

test("a word that appears more times in the new stream leaves the extras unpaired", () => {
	const pairs = pairWords(stream("count"), stream("count", " ", "count"));
	assert.deepEqual([...pairs], [[0, 0]], "the second one has nothing to come from, so it fades in");
});

test("punctuation and single characters are not followed", () => {
	// Every sample is full of these and they would pair arbitrarily across the file.
	const pairs = pairWords(stream("(", ")", "{", "a", "="), stream("=", "a", "{", ")", "("));
	assert.equal(pairs.size, 0);
});

test("whitespace is the gap between things, not a thing that moves", () => {
	const pairs = pairWords(stream("  ", "\n", "\t\t"), stream("\t\t", "\n", "  "));
	assert.equal(pairs.size, 0);
});

test("a word only pairs with the same word", () => {
	const pairs = pairWords(stream("setCount"), stream("setValue"));
	assert.equal(pairs.size, 0);
});

test("travel is measured from where it was to where it is", () => {
	const pairs = new Map([[5, 2]]);
	const was = new Map([[2, { left: 100, top: 40 }]]);
	const now = new Map([[5, { left: 30, top: 90 }]]);
	assert.deepEqual([...travels(pairs, was, now)], [[5, { dx: 70, dy: -50 }]], "the offset it starts from");
});

test("a word that did not move is not animated at all", () => {
	const pairs = new Map([[1, 1]]);
	const spot = { left: 12, top: 34 };
	assert.equal(travels(pairs, new Map([[1, spot]]), new Map([[1, { ...spot }]])).size, 0);
	// Sub-pixel drift is not movement either.
	assert.equal(travels(pairs, new Map([[1, spot]]), new Map([[1, { left: 12.2, top: 34.1 }]])).size, 0);
});

test("a pair with no measurement on either side is skipped rather than guessed at", () => {
	const pairs = new Map([[1, 1]]);
	assert.equal(travels(pairs, new Map(), new Map([[1, { left: 0, top: 0 }]])).size, 0);
	assert.equal(travels(pairs, new Map([[1, { left: 0, top: 0 }]]), new Map()).size, 0);
});
