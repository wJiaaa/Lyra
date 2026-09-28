import assert from "node:assert/strict";
import { test } from "node:test";
import type { Entry } from "@plume/core/trajectory-view";
import { draggedRange, timelineHit } from "../src/features/conversation/trajectory/timeline-geometry.ts";

const span = { start: 0, end: 1000 };
const entry = (source: Entry["source"], start: number, end: number): Entry => ({ seq: start, ts: start, startedAt: start, finishedAt: end, source, summary: source, detail: source });

test("timeline clicks preserve the filter below the drag threshold, including reverse and bounded drags", () => {
	assert.equal(draggedRange(50, 52.9, 100, span), null);
	assert.equal(draggedRange(50, 48, 100, span), null);
	assert.deepEqual(draggedRange(75, 25, 100, span), { start: 250, end: 750 });
	assert.deepEqual(draggedRange(-10, 120, 100, span), span);
	assert.equal(draggedRange(-10, -5, 100, span), null);
});

test("timeline hits agree with painted lane bands, clipping and minimum width, even for overlaps", () => {
	const model = entry("request", 100, 101), tool = entry("tool-call", 100, 200), later = entry("request", 110, 111);
	const points = [model, tool, later];
	assert.equal(timelineHit(points, 10, 3, 100, span), model);
	assert.equal(timelineHit(points, 11.5, 8, 100, span), later, "the last painted overlapping marker owns the hit");
	assert.equal(timelineHit(points, 15, 24, 100, span), tool);
	for (const y of [-1, 0, 13, 15, 16, 48]) assert.equal(timelineHit(points, 11, y, 100, span), undefined);
	assert.equal(timelineHit(points, 13, 8, 100, span), undefined);
	assert.equal(timelineHit(points, 10, 8, 0, span), undefined);
});
