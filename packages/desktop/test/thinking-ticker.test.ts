/**
 * How the reasoning is cut into runs for the thinking line's ticker.
 *
 * A claim about what the reader sees, and one that goes wrong in ways that look plausible in
 * code — an italic rule that eats the underscores out of identifiers, a blank line that
 * becomes an empty run and a double gap.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { thinkingRuns, thinkingTail } from "../src/features/conversation/thinking-ticker.ts";

test("every line is a run; blank lines are not", () => {
	assert.deepEqual(thinkingRuns("I need to:\n\n1. Read the diff\n2. Check the tests\n"), [
		"I need to:",
		"Read the diff",
		"Check the tests",
	]);
});

test("markdown marks come off and the words stay", () => {
	assert.deepEqual(
		thinkingRuns(
			"## Plan\n> quoted\n- **bold** and *it* and `code`\n[label](https://x) ![alt](a.png)\n```ts\nconst x = 1\n```",
		),
		["Plan", "quoted", "bold and it and code", "label alt", "const x = 1"],
	);
});

test("an underscore inside an identifier is not emphasis", () => {
	assert.deepEqual(thinkingRuns("call snake_case_name then other_thing"), ["call snake_case_name then other_thing"]);
});

test("runs of whitespace collapse to one space", () => {
	assert.deepEqual(thinkingRuns("a   b\t\tc  "), ["a b c"]);
});

test("consecutive duplicate runs are deduplicated", () => {
	assert.deepEqual(
		thinkingRuns(
			"### Verifying Tailwind Version Adoption\n### Verifying Tailwind Version Adoption\nChecking packages\n### Verifying Tailwind Version Adoption\n",
		),
		["Verifying Tailwind Version Adoption", "Checking packages", "Verifying Tailwind Version Adoption"],
	);
});

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
