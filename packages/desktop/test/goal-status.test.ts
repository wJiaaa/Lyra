/**
 * 目标状态条上那一句话：每种状态说什么、倒计时怎么取整、停下的原因说成人话。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { GoalState } from "@plume/core";
import { MAX_ROUNDS } from "../../core/src/runtime/session-goal.ts";
import { GOAL_MAX_ROUNDS, goalCountdown, goalStatusText, goalTone } from "../src/lib/goal-status.ts";
import { noticeText } from "../src/lib/notice-text.ts";
import { setActiveLocale, translate } from "../src/i18n/translate.ts";

const goal = (patch: Partial<GoalState>): GoalState => ({ text: "CI 变绿", startedAt: 1, status: "working", rounds: 0, noProgress: 0, judgeFailures: 0, waits: 0, ...patch });

test("状态条上的判定上限和 core 的是同一个数", () => {
	assert.equal(GOAL_MAX_ROUNDS, MAX_ROUNDS);
});

test("在等时说还要多久，按秒向上取整；到点了还没醒说「马上」", () => {
	assert.equal(goalCountdown(1000 + 30_000, 1000), "0:30");
	assert.equal(goalCountdown(1000 + 90_400, 1000), "1:31", "还剩 90.4 秒，写 1:31 而不是 1:30");
	assert.equal(goalCountdown(1000, 1000), null);
	assert.equal(goalStatusText(goal({ status: "waiting", wakeAt: 61_000 }), 1000), translate("goal.waiting", { time: "1:00" }));
	assert.equal(goalStatusText(goal({ status: "waiting", wakeAt: 500 }), 1000), translate("goal.waitingSoon"));
});

test("每种状态各有一句，停下的那句带着人话的原因", () => {
	assert.equal(goalStatusText(goal({ status: "working" }), 0), translate("goal.working"));
	assert.equal(goalStatusText(goal({ status: "judging" }), 0), translate("goal.judging"));
	assert.equal(goalStatusText(goal({ status: "met" }), 0), translate("goal.met"));
	assert.equal(goalStatusText(goal({ status: "impossible" }), 0), translate("goal.impossible"));
	const paused = goalStatusText(goal({ status: "paused", pausedFor: "no-progress" }), 0);
	assert.ok(paused.includes(translate("goal.pause.no-progress")), paused);
	assert.ok(!paused.includes("no-progress"), "代号不该漏到界面上");
});

test("进行中是强调色，达成是绿，走不到是红，停下是灰", () => {
	assert.deepEqual(["working", "judging", "waiting", "met", "impossible", "paused"].map((status) => goalTone(goal({ status: status as GoalState["status"] }))),
		["active", "active", "active", "ok", "danger", "quiet"]);
});

test("goal-paused 通知把原因代号换成人话", () => {
	const text = noticeText({ type: "notice", level: "warn", message: "Goal paused (budget)", code: "goal-paused", params: { why: "budget", rounds: 50, goal: "CI 变绿" } });
	assert.ok(text.includes(translate("goal.pause.budget")) && text.includes("50") && text.includes("CI 变绿"), text);
	assert.ok(!text.includes("budget"), text);
});

test("goal-paused 通知的英文按判定次数选单复数：判定一次就停，不说 1 times", () => {
	setActiveLocale("en");
	try {
		const paused = (rounds: number) => noticeText({ type: "notice", level: "warn", message: "Goal paused (stopped)", code: "goal-paused", params: { why: "stopped", rounds, goal: "CI" } });
		assert.match(paused(1), /Checked 1 time\./);
		assert.match(paused(3), /Checked 3 times\./);
	} finally {
		setActiveLocale("zh-CN");
	}
});
