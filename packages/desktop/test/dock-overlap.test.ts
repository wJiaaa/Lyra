/**
 * What a row does when it genuinely cannot hold its panes' floors.
 *
 * The dock draws the conversation and one tab. Usually a dock too narrow for the two side by side
 * is tall enough to stack them, and `fitTree` turns the row on its side. When neither axis fits,
 * dividing what there is in proportion to the floors would put *both* panes below their minimum: a
 * 420pt conversation drawn at 320 breaks its words one per line, and the terminal beside it wraps
 * its own prompt.
 *
 * So the tab keeps its floor and the conversation's box absorbs the shortfall; a `min-width` then
 * draws the conversation at its floor anyway, so it extends past its box and the tab covers the
 * overhang. The conversation stays laid out at the width it says it is and has its right-hand side
 * covered, rather than reflowing.
 *
 * These tests are about the *boxes*. That the first pane is then drawn wider than its box is CSS —
 * the `min-width` from `panePaintMinWidth`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { CONVERSATION_MIN_WIDTH_PX, PANEL_MIN_WIDTH_PX, paneFloor, panePaintMinWidth } from "../src/features/dock/geometry.ts";
import { fitTree, layoutPanes } from "../src/features/dock/layout.ts";
import { tabbedTree } from "../src/features/dock/tabs.ts";
import { leafOf, type DockNode } from "../src/features/dock/tree.ts";

/** Boxes in pixels, keyed by kind, of a tree fitted into a span. */
function drawn(tree: DockNode, span: { width: number; height: number }) {
	const fitted = fitTree(tree, span, paneFloor);
	const boxes = layoutPanes(fitted).map((pane) => ({
		kind: pane.kind,
		left: pane.left * span.width,
		width: pane.width * span.width,
		top: pane.top * span.height,
		height: pane.height * span.height,
	}));
	return { fitted, boxes, of: (kind: string) => boxes.find((box) => box.kind === kind)! };
}

const TERMINAL = tabbedTree("terminal", 0.4);
/** Too narrow for 420 + 300 across, too short for 260 + 150 down. */
const CRAMPED = { width: 600, height: 350 };

test("the row keeps its shape and the tab keeps its floor", () => {
	const { fitted, of } = drawn(TERMINAL, CRAMPED);

	assert.equal(fitted.type === "split" && fitted.dir, "row", "a column would not fit either");
	assert.ok(Math.abs(of("terminal").width - PANEL_MIN_WIDTH_PX) < 0.5, `terminal ${of("terminal").width}`);
	assert.ok(Math.abs(of("terminal").height - CRAMPED.height) < 0.5, "and full height");
});

test("the conversation's box absorbs the shortfall, and is covered by exactly that much", () => {
	const { of } = drawn(TERMINAL, CRAMPED);
	const conversation = of("conversation");

	assert.ok(Math.abs(conversation.width - (CRAMPED.width - PANEL_MIN_WIDTH_PX)) < 0.5, `conversation box ${conversation.width}`);
	assert.equal(conversation.left, 0, "it starts at the left edge, where it is covered from");
	// Drawn at its floor by `min-width`; the difference is the overhang the tab covers.
	const covered = CONVERSATION_MIN_WIDTH_PX - conversation.width;
	const overflow = CONVERSATION_MIN_WIDTH_PX + PANEL_MIN_WIDTH_PX - CRAMPED.width;
	assert.ok(Math.abs(covered - overflow) < 0.5, `covered ${covered}, overflowed ${overflow}`);
	assert.ok(Math.abs(of("terminal").left - conversation.width) < 0.5, "and the tab starts where the conversation's box ends");
});

test("a dock with room for both is drawn at the stored share", () => {
	const wide = { width: 1600, height: 900 };
	const { fitted, of } = drawn(TERMINAL, wide);
	assert.deepEqual(fitted, TERMINAL);
	assert.ok(Math.abs(of("terminal").width - wide.width * 0.4) < 0.5);
});

test("a column never overlaps: that would cover a composer or a title bar", () => {
	const column: DockNode = { type: "split", dir: "col", children: [leafOf("conversation"), leafOf("terminal")], sizes: [0.6, 0.4] };
	const span = { width: 600, height: 300 };
	const { fitted, boxes } = drawn(column, span);

	assert.equal(fitted.type === "split" && fitted.dir, "col", "a row would not fit either");
	const total = boxes.reduce((sum, box) => sum + box.height, 0);
	assert.ok(Math.abs(total - span.height) < 0.5, `the column adds up, got ${total}`);
	const [top, bottom] = [...boxes].sort((a, b) => a.top - b.top);
	assert.ok(bottom.top >= top.top + top.height - 0.5, "stacked with no overlap");
});

test("when even the tab will not fit, the row divides rather than overflowing", () => {
	// The tab alone needs 300; there is no overhang that helps, the conversation's box would be negative.
	const span = { width: 250, height: 300 };
	const { boxes, of } = drawn(TERMINAL, span);
	const total = boxes.reduce((sum, box) => sum + box.width, 0);
	assert.ok(Math.abs(total - span.width) < 0.5, `still adds up, got ${total}`);
	assert.ok(of("conversation").width > of("terminal").width, "and the conversation gets the larger piece, its floor being larger");
});

test("the overlap is re-derived from the size, so widening gives the layout straight back", () => {
	const saved = structuredClone(TERMINAL);
	drawn(TERMINAL, CRAMPED);
	assert.deepEqual(TERMINAL, saved, "the drawn tree is never rewritten by what the window can hold");

	const { of } = drawn(TERMINAL, { width: 1600, height: 900 });
	assert.ok(of("conversation").width >= CONVERSATION_MIN_WIDTH_PX, "and the room comes back on its own");
});

test("a pane that fills the dock is not painted past the window", () => {
	assert.equal(panePaintMinWidth("conversation", 1, false), undefined);
	assert.equal(panePaintMinWidth("conversation", 0.24, false), CONVERSATION_MIN_WIDTH_PX);
	assert.equal(panePaintMinWidth("conversation", 0.24, true), undefined);
	assert.equal(panePaintMinWidth("terminal", 0.4, false), PANEL_MIN_WIDTH_PX);
	assert.equal(paneFloor("conversation").width, CONVERSATION_MIN_WIDTH_PX);
});
