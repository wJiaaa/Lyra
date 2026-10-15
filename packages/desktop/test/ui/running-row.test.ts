/**
 * The 「运行中」 row folds away with its content still in it.
 *
 * Its `data-open` and its content used to be one condition, so a turn that ended without an answer
 * (only tools, stopped, failed) or a compaction starting emptied the row in the frame its fold began:
 * nothing was left to animate, and a transcript pinned to the bottom lost the row's height at once.
 * happy-dom runs no transitions, so the tests deliver the `transitionend` the fold would end with.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h } from "react";

import { RunningRow } from "../../src/features/conversation/RunningRow.tsx";
import { fire, mount } from "../helpers/mount.ts";

/** happy-dom's `TransitionEvent` drops `propertyName` from its init, so it is put on by hand. */
function foldEnds(row: Element, propertyName: string) {
	const event = new Event("transitionend", { bubbles: true });
	Object.defineProperty(event, "propertyName", { value: propertyName });
	return fire(row, event);
}

test("a turn that ends without an answer folds the row with the indicator still in it", async () => {
	const view = await mount(h(RunningRow, { running: true, answering: false, answered: false, compacting: false }));
	try {
		const row = view.find(".ly-reveal");
		assert.equal(row.dataset.open, "true");
		assert.ok(view.host.querySelector("[data-ly-running]"), "the indicator shows while the turn runs");

		await view.rerender(h(RunningRow, { running: false, answering: false, answered: false, compacting: false }));
		assert.equal(row.dataset.open, "false", "the fold starts at once");
		assert.ok(view.host.querySelector("[data-ly-running]"), "emptied in the frame the fold began");

		await foldEnds(row, "opacity");
		assert.ok(view.host.querySelector("[data-ly-running]"), "the fade ending is not the fold ending");
		await foldEnds(row, "grid-template-rows");
		assert.ok(!view.host.querySelector("[data-ly-running]"), "kept after the fold had finished");
	} finally {
		await view.unmount();
	}
});

test("a compaction starting folds the row the same way", async () => {
	const view = await mount(h(RunningRow, { running: true, answering: false, answered: false, compacting: false }));
	try {
		await view.rerender(h(RunningRow, { running: true, answering: false, answered: false, compacting: true }));
		const row = view.find(".ly-reveal");
		assert.equal(row.dataset.open, "false");
		assert.ok(view.host.querySelector("[data-ly-running]"));
		await foldEnds(row, "grid-template-rows");
		assert.ok(!view.host.querySelector("[data-ly-running]"));
	} finally {
		await view.unmount();
	}
});

test("while the answer arrives the row is only hidden: it keeps its height, and is back when the answer pauses", async () => {
	const view = await mount(h(RunningRow, { running: true, answering: false, answered: false, compacting: false }));
	try {
		const row = view.find(".ly-reveal");
		await view.rerender(h(RunningRow, { running: true, answering: true, answered: false, compacting: false }));
		assert.equal(row.dataset.open, "true", "folding here moved the transcript before the first words were drawn");
		assert.ok(view.host.querySelector("[data-ly-running-quiet]"), "hidden while words are landing");
		assert.ok(view.host.querySelector("[data-ly-running]"), "still drawn, so its height stays");

		// 回答停住超过 STALL_MS：同一格里亮回来，高度没动过。
		await view.rerender(h(RunningRow, { running: true, answering: false, answered: false, compacting: false }));
		assert.equal(row.dataset.open, "true");
		assert.ok(!view.host.querySelector("[data-ly-running-quiet]"));
	} finally {
		await view.unmount();
	}
});

test("a finished answer takes the row's place in one frame, with nothing left behind", async () => {
	const view = await mount(h(RunningRow, { running: true, answering: true, answered: false, compacting: false }));
	try {
		const row = view.find(".ly-reveal");
		// 消息先定稿（回答底下的操作行在这一次提交里长出来），`running` 晚一步才落下。
		await view.rerender(h(RunningRow, { running: true, answering: false, answered: true, compacting: false }));
		assert.equal(row.dataset.open, "false", "the reply's action row is growing in this same commit");
		assert.equal(row.style.transition, "none", "an animated fold would sink the answer after the action row lifted it");
		assert.ok(!view.host.querySelector("[data-ly-running-quiet]"), "not flashed back in before the turn ends");

		await view.rerender(h(RunningRow, { running: false, answering: false, answered: true, compacting: false }));
		assert.ok(!view.host.querySelector("[data-ly-running]"), "an indicator stayed mounted after the turn");

		// 下一轮开始：最后一条成了人说的话，照常展开。
		await view.rerender(h(RunningRow, { running: true, answering: false, answered: false, compacting: false }));
		assert.equal(row.dataset.open, "true");
		assert.equal(row.style.transition, "", "the next turn opens with the usual reveal");
	} finally {
		await view.unmount();
	}
});
