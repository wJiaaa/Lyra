/**
 * Which dispatched tasks the side chat keeps on screen after they are over.
 *
 * The rule is not "finished tasks linger" — it is "tasks whose outcome you do not already know
 * linger". Withdrawing one yourself tells you the outcome at the moment you click, so the row is a
 * receipt for a decision you just made. Being cancelled *because the main session was paused* does
 * not: the task was running, you stopped something else, and it went with it.
 *
 * That distinction was missing, and its absence was reported as work disappearing — a task
 * dispatched from the side chat, shown as running, then simply gone from the list the moment the
 * main conversation was paused.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { QueuedTask } from "@plume/core";
import { isResumable, TaskQueue } from "../../core/src/runtime/task-queue.ts";

const ran: string[] = [];
function queue(): TaskQueue {
	let n = 0;
	return new TaskQueue({
		now: () => 1,
		newId: () => `t${++n}`,
		changed: async () => {},
		run: async (task: QueuedTask) => {
			ran.push(task.text);
		},
		// Busy throughout: nothing should start draining while these are being inspected.
		busy: () => true,
	});
}

test("withdrawing a task records that you did it", async () => {
	const q = queue();
	const task = await q.enqueue("做点什么", "side-chat");
	await q.cancel(task.id);
	assert.equal(q.list()[0].status, "cancelled");
	assert.equal(q.list()[0].cancelledBy, "user", "是你按的撤回");
});

test("stopping the main session records that the session did it", async () => {
	const q = queue();
	await q.enqueue("做点什么", "side-chat");
	await q.cancelAll();
	assert.equal(q.list()[0].status, "cancelled");
	assert.equal(
		q.list()[0].cancelledBy,
		"stop",
		"任务是随主会话停下的，不是你撤的——面板必须把这件事说出来，否则派出去的活看起来就是凭空没了",
	);
});

test("a finished task can be cleared away, one still queued cannot", async () => {
	const q = queue();
	const first = await q.enqueue("一", "side-chat");
	await q.cancel(first.id);
	assert.equal(await q.dismiss(first.id), true, "结束了的可以从列表移除");

	const second = await q.enqueue("二", "side-chat");
	assert.equal(await q.dismiss(second.id), false, "还排着队的不能——那看起来像取消，但并不是");
	assert.equal(q.list().some((t) => t.id === second.id), true);
});

/*
 * Picking work back up, which used to be impossible.
 *
 * The two ways a dispatched task stops without finishing are the session being paused under it and
 * the task failing. Both were terminal: the row said what had happened and nothing could act on it,
 * so work the side chat had asked for was quietly never done.
 */
test("a task interrupted by a pause can be picked back up", async () => {
	const q = queue();
	const task = await q.enqueue("做点什么", "side-chat");
	await q.cancelAll();
	assert.equal(isResumable(q.list()[0]), true, "随主会话中断的可以继续");

	assert.equal(await q.resume(task.id), true);
	assert.equal(q.list()[0].status, "queued", "回到队列里等着");
	assert.equal(q.list()[0].cancelledBy, undefined, "不再标着是被谁停的");
});

test("a task you withdrew is not offered a way back", async () => {
	const q = queue();
	const task = await q.enqueue("算了别做了", "side-chat");
	await q.cancel(task.id);
	assert.equal(isResumable(q.list()[0]), false, "你自己撤的，再给个「继续」是在问你刚才那下是不是按错了");
	assert.equal(await q.resume(task.id), false);
	assert.equal(q.list()[0].status, "cancelled");
});

test("a failed task is offered a retry", async () => {
	const q = queue();
	const task = await q.enqueue("会失败的活", "side-chat");
	// Straight to failed, the way the runner marks one that threw.
	q.list()[0].status = "failed";
	q.list()[0].error = "连接中断";
	assert.equal(isResumable(q.list()[0]), true);
	assert.equal(await q.resume(task.id), true);
	assert.equal(q.list()[0].status, "queued");
});

test("a finished task is not resumable — asking again is a new dispatch", async () => {
	const q = queue();
	const task = await q.enqueue("已经做完了", "side-chat");
	q.list()[0].status = "done";
	assert.equal(isResumable(q.list()[0]), false);
	assert.equal(await q.resume(task.id), false);
});
