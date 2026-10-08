/**
 * How a squeeze is shared out.
 *
 * The behaviour this pins down took several attempts to get right, and every wrong version looked
 * plausible in code: the conversation growing past its box and hiding under a panel, a merely-narrow
 * panel doing the same to the conversation, a boundary that simply stopped responding once a floor
 * was reached. What should happen is none of those — the squeeze moves to the other side of the
 * boundary, and the row always adds up to the row.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { CONVERSATION_MIN_WIDTH_PX, PANEL_MIN_WIDTH_PX, paneFloor } from "../src/features/dock/geometry.ts";
import { fitTree, layoutPanes, layoutSplitters, shareFromPointer } from "../src/features/dock/layout.ts";
import { leafOf, type DockNode } from "../src/features/dock/tree.ts";

/** A row of leaves at the given shares. */
const row = (kinds: string[], sizes: number[]): DockNode => ({
	type: "split",
	dir: "row",
	children: kinds.map((kind) => leafOf(kind as never)),
	sizes,
});

/** Widths in pixels, keyed by kind, of a tree fitted into a box. */
function widths(tree: DockNode, width: number, height = 900): Record<string, number> {
	const fitted = fitTree(tree, { width, height }, paneFloor);
	const out: Record<string, number> = {};
	for (const pane of layoutPanes(fitted)) out[pane.kind] = pane.width * width;
	return out;
}

test("a layout that already fits is left exactly as it is", () => {
	const got = widths(row(["conversation", "terminal"], [0.6, 0.4]), 1600);
	assert.ok(Math.abs(got.conversation - 960) < 0.01);
	assert.ok(Math.abs(got.terminal - 640) < 0.01);
});

test("squeezing the conversation past its floor takes the room from the tab instead", () => {
	// The tab column has been dragged out to 85% — the conversation would be far below what it can be read at.
	const got = widths(row(["conversation", "terminal"], [0.15, 0.85]), 1000);
	assert.ok(got.conversation >= CONVERSATION_MIN_WIDTH_PX - 0.5, `the conversation kept its floor, got ${Math.round(got.conversation)}`);
	// And the total is still the total: nothing overflowed, the room moved.
	assert.ok(Math.abs(got.conversation + got.terminal - 1000) < 0.5);
});

test("the tab has a floor too, so a squeeze cannot erase it", () => {
	const got = widths(row(["conversation", "browser"], [0.98, 0.02]), 1600);
	assert.ok(got.browser >= PANEL_MIN_WIDTH_PX - 0.5, `the tab kept its floor, got ${Math.round(got.browser)}`);
	assert.ok(Math.abs(got.browser + got.conversation - 1600) < 0.5);
});

test("a box with no area is left alone rather than divided by zero", () => {
	const tree = row(["conversation", "browser"], [0.5, 0.5]);
	assert.deepEqual(fitTree(tree, { width: 0, height: 0 }, paneFloor), tree);
});


test("a narrow dock stacks usable panes before squeezing below their floors", () => {
	// The Windows failure: 770px client width minus a 272px pushed sidebar.
	const tree = row(["conversation", "terminal"], [0.62, 0.38]);
	const saved = structuredClone(tree);
	const span = { width: 498, height: 576 };
	const fitted = fitTree(tree, span, paneFloor);
	assert.equal(fitted.type, "split");
	if (fitted.type !== "split") throw new Error("missing split");
	assert.equal(fitted.dir, "col");
	const boxes = layoutPanes(fitted);
	assert.equal(boxes.length, 2);
	for (const box of boxes) {
		const floor = paneFloor(box.kind);
		assert.ok(box.width * span.width >= floor.width);
		assert.ok(box.height * span.height >= floor.height);
		assert.equal(box.left, 0); assert.equal(box.width, 1);
	}
	assert.equal(boxes[1].top, boxes[0].height);
	assert.equal(boxes[1].top + boxes[1].height, 1);
	const handles = layoutSplitters(fitted);
	assert.equal(handles.length, 1);
	assert.equal(handles[0].dir, "col");
	assert.equal(handles[0].top, boxes[1].top);
	assert.ok(Math.abs(shareFromPointer(handles[0], boxes[1].top * span.height, { left: 0, top: 0, ...span }) - handles[0].share) < 1e-6);
	assert.deepEqual(tree, saved, "responsive layout never writes a new axis or ratio into storage");
	assert.deepEqual(fitTree(tree, { width: 1200, height: 900 }, paneFloor), saved, "widening restores the saved arrangement");
});

test("a short dock uses the horizontal room when a saved column cannot fit", () => {
	const tree: DockNode = { type: "split", dir: "col", children: [leafOf("conversation"), leafOf("terminal")], sizes: [0.5, 0.5] };
	const fitted = fitTree(tree, { width: 1000, height: 300 }, paneFloor);
	assert.equal(fitted.type === "split" && fitted.dir, "row");
	for (const box of layoutPanes(fitted)) {
		assert.ok(box.width * 1000 >= paneFloor(box.kind).width);
		assert.equal(box.height, 1);
	}
	assert.equal(tree.dir, "col");
});
