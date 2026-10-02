import assert from "node:assert/strict";
import test from "node:test";
import { SessionActivity } from "../src/runtime/session-activity.ts";

/** A promise and the hand that settles it. */
function gate() {
	let open!: () => void;
	const opened = new Promise<void>((resolve) => (open = resolve));
	return { opened, open };
}

test("a hold counts as running from before its first line, so a submission during the first write queues", async () => {
	const activity = new SessionActivity();
	let seenInside: boolean | undefined;
	const held = activity.hold("prompt", async () => {
		seenInside = activity.running;
	});
	assert.equal(activity.running, true);
	await held;
	assert.equal(seenInside, true);
	assert.equal(activity.running, false);
	assert.equal(activity.holding("prompt"), null);
});

test("a prompt and an opening-message resume overlapping: the first to finish does not mark the session idle", async () => {
	const activity = new SessionActivity();
	const prompt = gate();
	const resume = gate();
	const a = activity.hold("prompt", () => prompt.opened);
	const b = activity.hold("resume", () => resume.opened);
	prompt.open();
	await a;
	assert.equal(activity.running, true, "the resume still holds the history");
	assert.ok(activity.holding("resume"));
	resume.open();
	await b;
	assert.equal(activity.running, false);
});

test("a hold that fails still lets go, and the failure reaches whoever waits on it", async () => {
	const activity = new SessionActivity();
	await assert.rejects(activity.hold("prompt", async () => { throw new Error("disk full"); }), /disk full/);
	assert.equal(activity.running, false);
});

test("stop aborts the running turn and is visible to work that took a mark before it", async () => {
	const activity = new SessionActivity();
	const mark = activity.mark();
	const signal = activity.beginTurn();
	assert.equal(activity.running, true);
	assert.equal(activity.stopping, false);
	activity.stop();
	assert.equal(signal.aborted, true);
	assert.equal(activity.stopping, true);
	assert.equal(activity.stoppedSince(mark), true);
	assert.equal(activity.stoppedSince(activity.mark()), false, "a mark taken after the stop is current");
	activity.endTurn();
	assert.equal(activity.running, false);
	assert.equal(activity.stopping, false);
});

test("settled waits for the prompt and then for the turn's tools", async () => {
	const activity = new SessionActivity();
	const tools = gate();
	const order: string[] = [];
	const prompt = activity.hold("prompt", async () => {
		activity.beginTurn();
		activity.trackTurn(tools.opened.then(() => { order.push("turn"); }));
		order.push("prompt");
	});
	const settled = activity.settled().then(() => order.push("settled"));
	await prompt;
	tools.open();
	await settled;
	assert.deepEqual(order, ["prompt", "turn", "settled"]);
});

test("a manual compaction holds the session, can be stopped, and clears itself when done", async () => {
	const activity = new SessionActivity();
	const done = gate();
	let signal: AbortSignal | undefined;
	const task = activity.compact(async (given) => {
		signal = given;
		await done.opened;
		return { ok: true };
	});
	assert.equal(activity.running, true);
	assert.equal(activity.compaction, task);
	activity.stop();
	assert.equal(signal?.aborted, true);
	done.open();
	assert.deepEqual(await task, { ok: true });
	assert.equal(activity.compaction, null);
	assert.equal(activity.running, false);
});

test("steerable follows the loop's own start and end, not the hold around it", async () => {
	const activity = new SessionActivity();
	const loop = gate();
	const held = activity.hold("prompt", async () => {
		activity.observe({ type: "agent_start", sessionId: "s" });
		await loop.opened;
		activity.observe({ type: "agent_end", reason: "done" });
	});
	await Promise.resolve();
	assert.equal(activity.steerable, true);
	loop.open();
	await held;
	assert.equal(activity.steerable, false);
});
