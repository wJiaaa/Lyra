/**
 * The size a shell is born at.
 *
 * A pty wraps its output to the width it was given when it was created, and nothing can re-wrap
 * what has already been written — so a shell started at 80 columns and shown in a pane 38 wide has
 * a greeting broken mid-word, permanently. The resize that follows only affects what comes next.
 *
 * That is what makes this an ordering problem rather than a sizing one: the number is only right
 * if the terminal has been measured before the shell is asked for. React guarantees that ordering
 * between a layout effect and a passive one, which is the whole of the fix — but the guarantee is
 * worth stating, because the previous version had them in the same effect and depended on a race
 * it usually won.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * The two effects, in the order React runs them.
 *
 * `measure` stands for the layout effect that builds the terminal and records its size; `open`
 * for the passive effect that starts a shell when the project has none.
 */
function mount(paneCols: number, paneRows: number, opts: { measures: boolean }) {
	const size = { cols: 80, rows: 24 };
	if (opts.measures) {
		size.cols = paneCols;
		size.rows = paneRows;
	}
	return { bornAt: { ...size } };
}

test("a shell is born at the width of the pane it will be shown in", () => {
	const narrow = mount(38, 20, { measures: true });
	assert.deepEqual(narrow.bornAt, { cols: 38, rows: 20 });
});

test("without a measurement first, it is born at a guess — the bug", () => {
	/*
	 * What happened when the terminal was built only once a tab was active: on the first visit to a
	 * project there is no tab yet, so nothing had been measured when the shell was opened.
	 */
	const guessed = mount(38, 20, { measures: false });
	assert.deepEqual(guessed.bornAt, { cols: 80, rows: 24 }, "80×24, whatever the pane is");
	assert.notEqual(guessed.bornAt.cols, 38, "which is the wrap the output is stuck with");
});

test("the wrap a shell is stuck with is the width it started at, not the width it ends up", () => {
	/*
	 * Why a later resize does not rescue it. The greeting is bytes with newlines already in them;
	 * re-flowing is not something a terminal can do to text it has already received.
	 */
	const wrapAt = (text: string, cols: number) => {
		const out: string[] = [];
		for (let i = 0; i < text.length; i += cols) out.push(text.slice(i, i + cols));
		return out;
	};
	const line = "/Users/me/.zshrc:.:64: no such file or directory: /tmp/project-venv/env";

	// Born at 80, shown at 38: the breaks are in the wrong places and stay there.
	const wrong = wrapAt(line, 80);
	const right = wrapAt(line, 38);
	assert.notDeepEqual(wrong, right);
	assert.ok(right.every((row) => row.length <= 38), "wrapped for the pane it is in");
	assert.ok(wrong.some((row) => row.length > 38), "wrapped for a pane it is not in");
});

test("resizing still matters for everything written afterwards", () => {
	// The ResizeObserver is not redundant — it is what keeps a running program correct when the
	// pane is dragged. It just cannot fix the past.
	const born = mount(38, 20, { measures: true });
	const afterDrag = { cols: 92, rows: 30 };
	assert.notDeepEqual(born.bornAt, afterDrag, "the shell must be told, or it keeps wrapping at 38");
});
