/**
 * A scheduled run that fails after it started.
 *
 * The attempt is saved as soon as the session exists, without an error, and the turn is not awaited.
 * A turn that failed minutes later sent a notice and left the task's card saying nothing was wrong.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSession, ScheduledTask, Settings } from "@lyra/core";
import { Scheduler } from "../electron/scheduler.ts";

const task: ScheduledTask = {
	id: "t1",
	name: "日报",
	cwd: "/unused",
	prompt: "noop",
	schedule: { kind: "interval", minutes: 60 },
	enabled: true,
} as ScheduledTask;

test("一轮开始后才失败，失败也写到任务上", async () => {
	let settings = { scheduledTasks: [task], defaultModelId: "m" } as unknown as Settings;
	let rejectTurn!: (cause: Error) => void;
	const notices: string[] = [];
	const scheduler = new Scheduler({
		getSettings: () => settings,
		saveSettings: async (next) => {
			settings = next;
		},
		createSession: async () =>
			({ meta: { id: "s1" }, prompt: () => new Promise((_, reject) => (rejectTurn = reject)) }) as unknown as AgentSession,
		notify: (_message, level) => void notices.push(level),
	});

	await scheduler.tick(Date.UTC(2026, 8, 27));
	assert.equal(settings.scheduledTasks[0].lastSessionId, "s1");
	assert.equal(settings.scheduledTasks[0].lastError, undefined, "开始时还没有错");

	rejectTurn(new Error("模型不可用"));
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(notices, ["info", "error"]);
	assert.equal(settings.scheduledTasks[0].lastError, "模型不可用");
});

test("晚到的失败不覆盖之后那一次运行", async () => {
	let settings = { scheduledTasks: [{ ...task, lastSessionId: "s2" }], defaultModelId: "m" } as unknown as Settings;
	const scheduler = new Scheduler({
		getSettings: () => settings,
		saveSettings: async (next) => {
			settings = next;
		},
		createSession: async () => ({ meta: { id: "s1" }, prompt: async () => {} }) as unknown as AgentSession,
		notify: () => {},
	});
	// Reach the private method directly: the race it guards is a later run saved before this one failed.
	await (scheduler as unknown as { recordFailure(t: string, s: string, r: string): Promise<void> }).recordFailure("t1", "s1", "旧的失败");
	assert.equal(settings.scheduledTasks[0].lastError, undefined);
});
