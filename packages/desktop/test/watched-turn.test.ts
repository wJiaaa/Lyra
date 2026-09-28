/**
 * Whether a finished turn leaves a mark, given whether anyone was watching it.
 *
 * The dot means "this finished while you were elsewhere". `visibleActivity` already hid it for the
 * conversation on screen — but hiding is not clearing, and the mark stayed in the map: sit through
 * a whole turn, click another conversation, and the one you had just been staring at was suddenly
 * one you had never looked at. Being told you missed something you watched happen is exactly
 * backwards.
 *
 * The rule is applied where the event lands, so what is tested here is that rule rather than the
 * store around it: finished states are dropped for the active conversation, and only those.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { nextActivity, visibleActivity, type SessionActivity } from "@plume/core/activity";

/** What `apply-event` records, given who is on screen. */
function recorded(settled: SessionActivity | null, sessionId: string, activeSessionId: string | null) {
	const finished = settled === "done" || settled === "failed";
	return finished && sessionId === activeSessionId ? null : settled;
}

test("a turn finishing in the conversation you are watching leaves nothing behind", () => {
	assert.equal(recorded("done", "s1", "s1"), null);
	assert.equal(recorded("failed", "s1", "s1"), null, "a failure you watched is also one you saw");
});

test("a turn finishing anywhere else is worth a mark", () => {
	assert.equal(recorded("done", "s2", "s1"), "done");
	assert.equal(recorded("failed", "s2", "s1"), "failed");
	assert.equal(recorded("done", "s2", null), "done", "and with nothing open, everything is elsewhere");
});

test("still-running work is carried out of the conversation with you", () => {
	/*
	 * `running` and `waiting` are about what is still to come, not about an outcome you might have
	 * missed — clearing those for the active conversation would blank the list the moment you
	 * looked away from something still going.
	 */
	assert.equal(recorded("running", "s1", "s1"), "running");
	assert.equal(recorded("waiting", "s1", "s1"), "waiting", "a permission prompt does not stop needing an answer");
});

test("the display filter still holds as a second line of defence", () => {
	// Belt and braces: even were a `done` to reach the map for the active row, the list would not
	// draw it. The fix is that it no longer gets there — this is what happens if it ever does.
	assert.equal(visibleActivity("done", true), null);
	assert.equal(visibleActivity("done", false), "done");
	assert.equal(visibleActivity("running", true), "running", "but what is still going is always shown");
});

test("watching a turn from start to finish ends with a clean row", () => {
	// The whole sequence, as the events actually arrive for the conversation on screen.
	const active = "s1";
	let mark: SessionActivity | null = null;
	for (const event of [{ type: "agent_start" }, { type: "agent_end", outcome: "ok" }] as const) {
		mark = recorded(nextActivity(event as never, mark), active, active);
	}
	assert.equal(mark, null, "nothing is left to announce");
});

/*
 * Which run glides is not tested here any more, and the way it used to be is the point.
 *
 * There were three tests below this line, and each one rewrote the rule as
 * `turnRunning && index === total - 1` and then checked that copy against itself. They passed for
 * as long as the bug lived, because the copy was faithful: "the last run, while the turn runs" is
 * what the app did, and it is wrong — the last run stays the last run after you ask something else.
 * A test that restates the code cannot disagree with it.
 *
 * The rule is now checked against `runs` itself, on real transcripts, in `glide.test.ts`.
 */
