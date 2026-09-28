import assert from "node:assert/strict";
import { test } from "node:test";
import type { Entry } from "@plume/core/trajectory-view";
import { applyTrajectoryChanges } from "../src/features/conversation/trajectory/trajectory-state.ts";

const entry = (id: string): Entry => ({ id, seq: 1, ts: 1, source: "tool-call", summary: id, detail: id });
test("trajectory deltas retain unchanged identities, replace updates in place and append new records", () => {
	const first = entry("first"), second = entry("second"), updated = { ...second, output: "done" }, third = entry("third");
	const previous = [first, second];
	assert.equal(applyTrajectoryChanges(previous, { cursor: "1", reset: false, upserts: [], removals: [] }), previous);
	const next = applyTrajectoryChanges(previous, { cursor: "2", reset: false, upserts: [updated, third], removals: [] });
	assert.deepEqual(next, [first, updated, third]); assert.equal(next[0], first);
	assert.equal(previous[1], second);
	assert.deepEqual(applyTrajectoryChanges(next, { cursor: "3", reset: false, upserts: [], removals: ["second", "third"] }), [first]);
	assert.deepEqual(applyTrajectoryChanges(next, { cursor: "4", reset: true, upserts: [], removals: [] }), []);
});
