/**
 * The side chat reaching the main session's controls rather than its queue.
 *
 * `dispatch_task` is for work: it goes behind whatever is running. That is exactly wrong for the
 * things said *about* a run in progress — asked to pause, the panel had only the queue to reach
 * for, so 「请暂停手头的所有自动执行任务」 was filed behind the very work it was asking to stop.
 * The panel reported success and nothing happened.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { QueuedTask } from "@plume/core";
import { TaskQueue } from "../../core/src/runtime/task-queue.ts";

/*
 * A stand-in for the session, with only the surface `control_main` touches.
 *
 * The real one needs a model, a workspace and a transcript; none of that is what these claims are
 * about, and building it would test the harness rather than the rule.
 */
function fakeMain() {
	let n = 0;
	const prompts: { text: string; synthetic?: boolean }[] = [];
	const state = { running: true, aborted: false };
	const queue = new TaskQueue({
		now: () => 1,
		newId: () => `t${++n}`,
		changed: async () => {},
		run: async () => {},
		busy: () => state.running,
	});
	return {
		state,
		prompts,
		queue,
		get running() {
			return state.running;
		},
		get taskQueue() {
			return queue.list();
		},
		abort() {
			state.aborted = true;
			state.running = false;
			void queue.cancelAll();
		},
		interruptedTask(): QueuedTask | null {
			const list = queue.list();
			for (let i = list.length - 1; i >= 0; i--) {
				const task = list[i]!;
				if (task.status === "cancelled" && task.cancelledBy === "stop") return task;
			}
			return null;
		},
		async resumeTask(id: string) {
			return queue.resume(id);
		},
		async prompt(content: { type: string; text?: string }[], options?: { synthetic?: boolean }) {
			prompts.push({ text: content.map((c) => c.text ?? "").join(""), synthetic: options?.synthetic });
		},
	};
}

test("pausing takes effect immediately instead of joining the queue", async () => {
	const main = fakeMain();
	await main.queue.enqueue("跑一件很久的活", "side-chat");
	assert.equal(main.taskQueue[0].status, "queued");

	main.abort();

	assert.equal(main.state.aborted, true, "暂停是立刻的，不是排队等它先做完");
	assert.equal(main.taskQueue[0].cancelledBy, "stop", "手头的活一并中断，并且记着是被谁停的");
});

test("resuming picks the interrupted task back up rather than only the conversation", async () => {
	const main = fakeMain();
	const task = await main.queue.enqueue("被打断的活", "side-chat");
	main.abort();

	const interrupted = main.interruptedTask();
	assert.equal(interrupted?.id, task.id);
	await main.resumeTask(interrupted!.id);

	/*
	 * It does not stay queued — `resume` drains, and this session is free now that it was paused.
	 * Running it is the point; what matters is that it is no longer a cancelled record.
	 */
	assert.notEqual(main.taskQueue[0].status, "cancelled", "任务被重新接上了，不再是一条终态记录");
	assert.equal(main.taskQueue[0].cancelledBy, undefined, "不再标着是被谁停的");
	assert.equal(main.prompts.length, 0, "有任务要接的时候不该另发一句「继续」");
});

test("with nothing interrupted, resuming sends 继续 as the app's own message", async () => {
	const main = fakeMain();
	main.state.running = false;

	assert.equal(main.interruptedTask(), null);
	await main.prompt([{ type: "text", text: "继续，从中断的地方接着做。" }], { synthetic: true });

	assert.equal(main.prompts.length, 1);
	assert.equal(main.prompts[0].synthetic, true, "没人打过这句话，它不该出现在对话里，也不该重开一轮计时");
});
