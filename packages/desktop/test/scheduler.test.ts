/**
 * What the scheduler tells the window when a task starts or fails, in the interface language.
 *
 * The notice is put together here and shown by the window as it arrives, so the language has to be
 * decided here — the window has no way to translate a sentence it was handed whole.
 *
 * And a scheduled run that fails after it started. The attempt is saved as soon as the session
 * exists, without an error, and the turn is not awaited. A turn that failed minutes later sent a
 * notice and left the task's card saying nothing was wrong.
 */

import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import type { AgentSession, ScheduledTask, Settings } from "@lyra/core";
import { setInterfaceLocaleSource, type NativeLocale } from "../electron/i18n.ts";
import { Scheduler } from "../electron/scheduler.ts";

const task: ScheduledTask = {
	id: "nightly",
	name: "Nightly review",
	cwd: "/work/app",
	prompt: "Look over what changed.",
	schedule: { kind: "interval", minutes: 60 },
	enabled: true,
};

/** The interface language, as the main process would read it from the settings. */
let language: NativeLocale = "zh-CN";
setInterfaceLocaleSource(() => language);
beforeEach(() => {
	language = "zh-CN";
});
after(() => setInterfaceLocaleSource(() => "zh-CN"));

/** A scheduler whose one task is due, with `start` as what starting a session does. */
function scheduled(start: () => Promise<AgentSession>, name = task.name): { scheduler: Scheduler; notices: string[] } {
	const notices: string[] = [];
	let settings = { scheduledTasks: [{ ...task, name }], defaultModelId: "model" } as unknown as Settings;
	const scheduler = new Scheduler({
		getSettings: () => settings,
		saveSettings: async (next) => {
			settings = next;
		},
		createSession: start,
		notify: (message) => notices.push(message),
	});
	return { scheduler, notices };
}

/** A session that starts, and whose turn does whatever `turn` does. */
const session = (turn: () => Promise<unknown>) => async () => ({ meta: { id: "session" }, prompt: turn }) as unknown as AgentSession;

/** The turn is deliberately not awaited by the tick, so what it does arrives a moment later. */
const settled = () => new Promise((resolve) => setImmediate(resolve));

test("a task that cannot start says so in the interface language", async () => {
	const refused = async (): Promise<AgentSession> => {
		throw new Error("no model is configured");
	};
	for (const [locale, said] of [
		["en", "Scheduled task “Nightly review” could not start: no model is configured"],
		["zh-CN", "定时任务「Nightly review」无法启动：no model is configured"],
	] as const) {
		language = locale;
		const run = scheduled(refused);
		await run.scheduler.tick(Date.now());
		assert.deepEqual(run.notices, [said], locale);
	}
});

test("a task that starts and then fails says both in the interface language", async () => {
	const failing = session(() => Promise.reject(new Error("the model refused")));
	for (const [locale, said] of [
		["en", ["Scheduled task “Nightly review” started", "Scheduled task “Nightly review” failed: the model refused"]],
		["zh-CN", ["定时任务「Nightly review」开始运行", "定时任务「Nightly review」失败：the model refused"]],
	] as const) {
		language = locale;
		const run = scheduled(failing);
		await run.scheduler.tick(Date.now());
		await settled();
		assert.deepEqual(run.notices, said, locale);
	}
});

test("the language is read for each notice, so a failure after a language change uses the new one", async () => {
	/*
	 * The turn can fail minutes after it started. Words settled when the run began would still be
	 * English here, after the setting had moved on.
	 */
	let fail: (error: Error) => void = () => {};
	const run = scheduled(session(() => new Promise((_resolve, reject) => (fail = reject))));
	language = "en";
	await run.scheduler.tick(Date.now());
	language = "zh-CN";
	fail(new Error("rate limited"));
	await settled();
	assert.deepEqual(run.notices, ["Scheduled task “Nightly review” started", "定时任务「Nightly review」失败：rate limited"]);
});

test("a task name goes in as text, even when it looks like a replacement pattern or a slot", async () => {
	language = "en";
	const run = scheduled(session(() => Promise.reject(new Error("boom"))), "Swap $& for {reason}");
	await run.scheduler.tick(Date.now());
	await settled();
	assert.deepEqual(run.notices, ["Scheduled task “Swap $& for {reason}” started", "Scheduled task “Swap $& for {reason}” failed: boom"]);
});

const daily: ScheduledTask = {
	id: "t1",
	name: "日报",
	cwd: "/unused",
	prompt: "noop",
	schedule: { kind: "interval", minutes: 60 },
	enabled: true,
} as ScheduledTask;

test("一轮开始后才失败，失败也写到任务上", async () => {
	let settings = { scheduledTasks: [daily], defaultModelId: "m" } as unknown as Settings;
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
	let settings = { scheduledTasks: [{ ...daily, lastSessionId: "s2" }], defaultModelId: "m" } as unknown as Settings;
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
