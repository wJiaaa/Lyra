/**
 * 任务队列两个任务之间，人恰好发了话。
 *
 * 上一个任务的回合一结束会话就空了，人这时开了一轮；队列不再看一眼就去跑下一个，那个任务的
 * `prompt()` 会被当成插话塞进人的那一轮、立刻返回，然后被标成「完成」。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { TaskQueue } from "../src/runtime/task-queue.ts";
import type { QueuedTask } from "../src/agent/events.ts";

function queue() {
	let busy = false;
	const ran: string[] = [];
	let ids = 0;
	let onChange: (() => void) | undefined;
	const q: TaskQueue = new TaskQueue({
		run: async (task) => {
			ran.push(task.text);
		},
		busy: () => busy,
		changed: async () => onChange?.(),
		newId: () => `t${++ids}`,
		now: () => 0,
	});
	return { q, ran, setBusy: (value: boolean) => (busy = value), onChange: (fn: () => void) => (onChange = fn) };
}

const byText = (tasks: QueuedTask[], text: string) => tasks.find((task) => task.text === text)!;

test("上一个任务刚做完、人正好开了一轮：下一个任务不跑、留在队里", async () => {
	const h = queue();
	h.setBusy(true);
	await h.q.enqueue("一", "side-chat");
	await h.q.enqueue("二", "side-chat");
	// 第一个做完的那一刻，人发了话。
	h.onChange(() => {
		if (byText(h.q.list(), "一").status === "done") h.setBusy(true);
	});
	h.setBusy(false);
	await h.q.drain();

	assert.deepEqual(h.ran, ["一"], "第二个没被塞进人的那一轮");
	assert.equal(byText(h.q.list(), "二").status, "queued");

	// 那一轮结束，会话再叫一次 drain，它照常跑。
	h.onChange(() => {});
	h.setBusy(false);
	await h.q.drain();
	assert.deepEqual(h.ran, ["一", "二"]);
	assert.equal(byText(h.q.list(), "二").status, "done");
});

test("标成运行中、通知界面的那一下里人开了一轮：退回排队，不去撞那一轮", async () => {
	const h = queue();
	h.setBusy(true);
	await h.q.enqueue("一", "side-chat");
	h.onChange(() => {
		if (byText(h.q.list(), "一").status === "running") h.setBusy(true);
	});
	h.setBusy(false);
	await h.q.drain();

	assert.deepEqual(h.ran, []);
	const task = byText(h.q.list(), "一");
	assert.equal(task.status, "queued");
	assert.equal(task.startedAt, undefined);
});
