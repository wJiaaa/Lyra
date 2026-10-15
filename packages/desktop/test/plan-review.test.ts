import assert from "node:assert/strict";
import { test } from "node:test";

import { planFeedback, usePlanReview } from "../src/store/plan-review.ts";

const comment = (quote: string, text: string, start = 0) => ({ id: quote, quote, text, start, end: start + quote.length });

test("评论排成打回理由：引用块后空一行再写评论，人另写的话排在最前面", () => {
	assert.equal(planFeedback([comment("第二步", "先别动 schema")]), "> 第二步\n\n先别动 schema");
	assert.equal(planFeedback([comment("a", "x"), comment("b", "y")], "整体太大"), "整体太大\n\n> a\n\nx\n\n> b\n\ny");
});

test("引文压成一行，超过 200 个字只带开头", () => {
	const long = "字".repeat(250);
	const out = planFeedback([comment(`第一行\n  ${long}`, "改")]);
	assert.ok(out.startsWith(`> 第一行 ${"字".repeat(196)}…\n\n`));
});

test("同一次审批只算一次新计划；改完再交是新的一次，评论清空", () => {
	const store = usePlanReview.getState();
	assert.equal(store.show("s1", "r1", "# 计划"), true);
	assert.equal(usePlanReview.getState().show("s1", "r1", "# 计划"), false);
	usePlanReview.getState().add("s1", { quote: "后", start: 9, end: 10, text: "二" });
	usePlanReview.getState().add("s1", { quote: "前", start: 2, end: 3, text: "一" });
	// 按在正文里的先后排，不按留的先后。
	assert.deepEqual(usePlanReview.getState().reviews.s1?.comments.map((c) => c.text), ["一", "二"]);
	const first = usePlanReview.getState().reviews.s1!.comments[0]!;
	usePlanReview.getState().remove("s1", first.id);
	assert.deepEqual(usePlanReview.getState().reviews.s1?.comments.map((c) => c.text), ["二"]);
	assert.equal(usePlanReview.getState().show("s1", "r2", "# 计划 v2"), true);
	assert.deepEqual(usePlanReview.getState().reviews.s1?.comments, []);
});
