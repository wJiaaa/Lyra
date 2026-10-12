/**
 * 持续目标：裁判怎么读、怎么判，会话怎么据此续跑、睡觉、停下。
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentEvent } from "../src/agent/events.ts";
import { DEFAULT_SETTINGS, type Settings } from "../src/config/settings.ts";
import { buildSystemPrompt } from "../src/prompt/system.ts";
import { GOAL_JUDGE_SYSTEM, judgeMaterial, parseVerdict } from "../src/runtime/goal-judge.ts";
import { AgentSession } from "../src/runtime/session.ts";
import { MAX_JUDGE_FAILURES, MAX_NO_PROGRESS, MAX_ROUNDS, SessionGoal, WAIT_BACKOFF_MS, type GoalDeps } from "../src/runtime/session-goal.ts";
import { SessionStore } from "../src/session/store.ts";
import type { GoalState } from "../src/types/goal.ts";
import { emptyUsage, type AssistantMessage, type Message, type ModelConfig, type ProviderConfig } from "../src/types.ts";

const MODEL: ModelConfig = { id: "fake/model", providerId: "fake", modelId: "model", name: "Fake", contextWindow: 100_000, maxOutputTokens: 4096, supportsThinking: false, supportsImages: false, supportsTools: true };
const PROVIDER: ProviderConfig = { id: "fake", name: "Fake", baseUrl: "http://localhost", api: "openai-responses", apiKey: "x", enabled: true, models: [MODEL] };
const SETTINGS: Settings = { ...DEFAULT_SETTINGS, providers: [PROVIDER], defaultModelId: MODEL.id, mcpServers: [], permissionMode: "full", autoSummarizeTitle: false };
const reply = (text: string): AssistantMessage => ({ role: "assistant", content: [{ type: "text", text }], api: "openai-responses", provider: "fake", model: "model", usage: { ...emptyUsage(), input: 10, output: 5 }, stopReason: "stop", timestamp: Date.now() });
const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const verdictText = (kind: string, reason = "because") => JSON.stringify({ verdict: kind, reason });
const until = async (ok: () => boolean, what: string) => {
	for (let i = 0; i < 400 && !ok(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
	assert.ok(ok(), what);
};

test("the judge reads the goal, the list, the latest turn's calls and the last reply", () => {
	const call: AssistantMessage = { ...reply(""), content: [{ type: "toolCall", id: "c", name: "bash", arguments: {}, argumentsText: "{}" }], stopReason: "toolUse" };
	const material = judgeMaterial({
		goal: "CI 变绿",
		todos: [{ content: "修测试", status: "in_progress" }],
		messages: [user("开始"), reply("earlier, not shown"), user("继续"), call, call, reply("Tests: 3 passed")],
		previous: { kind: "progress", reason: "one failing", at: 1 },
	});
	assert.match(material, /^Goal: CI 变绿/);
	assert.match(material, /- \[in_progress\] 修测试/);
	assert.match(material, /Previous check: progress — one failing/);
	assert.match(material, /Latest turn: bash×2/);
	assert.match(material, /<reply>\nTests: 3 passed\n<\/reply>/);
	assert.doesNotMatch(material, /earlier, not shown/);
});

test("verdicts are read out of JSON, out of prose around it, and refused when absent", () => {
	assert.equal(parseVerdict('{"verdict":"met","reason":"done"}')?.kind, "met");
	assert.equal(parseVerdict('Sure. {"verdict": "Waiting", "reason": "the job"} hope that helps')?.reason, "the job");
	assert.equal(parseVerdict('{"verdict":"stuck","reason":"loops"')?.kind, "stuck", "a truncated object still names its verdict");
	assert.equal(parseVerdict("I think it is done"), null);
	assert.equal(parseVerdict('{"verdict":"maybe"}'), null);
});

/** 裁判驱动器的单元夹具：假的会话、脚本化的裁判回答。 */
function driver(script: string[], initial?: Partial<GoalState>) {
	let goal: GoalState | undefined = initial ? { text: "g", startedAt: 1, status: "working", rounds: 0, noProgress: 0, judgeFailures: 0, waits: 0, ...initial } : undefined;
	const events: AgentEvent[] = [];
	const continued: string[] = [];
	const records: unknown[] = [];
	let asked = 0;
	const deps: GoalDeps = {
		settings: () => SETTINGS,
		goal: () => goal,
		record: async (next) => { goal = next; },
		messages: () => [user("x"), reply("y")],
		todos: () => [],
		modelId: () => MODEL.id,
		stream: (_provider, _model, context) => {
			assert.equal(context.systemPrompt, GOAL_JUDGE_SYSTEM);
			const text = script[Math.min(asked++, script.length - 1)];
			// oxlint-disable-next-line require-yield
			return (async function* () { return reply(text); })();
		},
		append: async (record) => { records.push(record); },
		emit: async (event) => { events.push(event); },
		continueWith: async (text) => { continued.push(text); },
		idle: () => true,
		whenIdle: async () => {},
	};
	const sut = new SessionGoal(deps);
	return { sut, deps, state: () => goal, events, continued, records, asked: () => asked, set: (next: GoalState | undefined) => { goal = next; } };
}

test("progress continues at once, met ends with a notice, and every check records its usage", async () => {
	const d = driver([verdictText("progress", "two tests left"), verdictText("met", "all green")]);
	await d.sut.set("CI green");
	await d.sut.afterTurn("done");
	assert.equal(d.continued.length, 1);
	assert.match(d.continued[0], /two tests left[\s\S]*CI green/);
	assert.equal(d.state()?.status, "working");
	assert.equal(d.state()?.rounds, 1);
	await d.sut.afterTurn("done");
	assert.equal(d.state()?.status, "met");
	assert.equal(d.continued.length, 1, "a met goal is not continued");
	assert.equal(d.events.findLast((event) => event.type === "notice")?.code, "goal-met");
	assert.deepEqual(d.records.map((record) => (record as { source: string }).source), ["goal-judge", "goal-judge"]);
	// 终态之后再收尾什么也不做。
	await d.sut.afterTurn("done");
	assert.equal(d.asked(), 2);
});

test("waiting backs off 30s, 1m, 2m… and progress resets the ladder", async () => {
	const d = driver([verdictText("waiting", "the deploy"), verdictText("waiting", "still"), verdictText("progress"), verdictText("waiting")]);
	await d.sut.set("deploy done");
	const before = Date.now();
	await d.sut.afterTurn("done");
	assert.equal(d.state()?.status, "waiting");
	assert.ok((d.state()?.wakeAt ?? 0) - before >= WAIT_BACKOFF_MS[0] - 50);
	assert.ok((d.state()?.wakeAt ?? 0) - before <= WAIT_BACKOFF_MS[0] + 500);
	// 到点了：醒来的那一轮说清楚在等什么。
	d.set({ ...d.state()!, status: "waiting", wakeAt: Date.now() - 1 });
	d.sut.arm();
	await until(() => d.continued.length === 1, "woke up");
	assert.match(d.continued[0], /waiting for: the deploy/);
	assert.equal(d.state()?.status, "working");
	await d.sut.afterTurn("done");
	assert.equal(d.state()?.waits, 2);
	assert.ok((d.state()?.wakeAt ?? 0) - Date.now() > WAIT_BACKOFF_MS[1] - 1000, "second wait is longer");
	d.set({ ...d.state()!, status: "working" });
	await d.sut.afterTurn("done");
	assert.equal(d.state()?.waits, 0, "progress resets the ladder");
	await d.sut.afterTurn("done");
	assert.ok((d.state()?.wakeAt ?? 0) - Date.now() <= WAIT_BACKOFF_MS[0] + 500);
	d.sut.dispose();
});

test("the budget lines: rounds, consecutive no-progress, consecutive unreadable verdicts", async () => {
	const budget = driver([verdictText("progress")], { rounds: MAX_ROUNDS });
	await budget.sut.afterTurn("done");
	assert.equal(budget.state()?.status, "paused");
	assert.equal(budget.state()?.pausedFor, "budget");
	assert.equal(budget.asked(), 0, "over budget is decided before asking");
	assert.equal(budget.events.findLast((event) => event.type === "notice")?.code, "goal-paused");

	const stuck = driver([verdictText("stuck", "same thing again")], { noProgress: MAX_NO_PROGRESS - 2 });
	await stuck.sut.afterTurn("done");
	assert.equal(stuck.state()?.status, "working");
	assert.match(stuck.continued[0], /Change approach/);
	await stuck.sut.afterTurn("done");
	assert.equal(stuck.state()?.pausedFor, "no-progress");

	const unreadable = driver(["no idea"], { judgeFailures: 0 });
	for (let i = 1; i < MAX_JUDGE_FAILURES; i++) {
		await unreadable.sut.afterTurn("done");
		assert.equal(unreadable.state()?.status, "working", "an unreadable verdict is neither met nor stalled");
		assert.equal(unreadable.state()?.judgeFailures, i);
	}
	await unreadable.sut.afterTurn("done");
	assert.equal(unreadable.state()?.pausedFor, "judge-failed");
	assert.equal(unreadable.records.length, MAX_JUDGE_FAILURES, "usage is recorded even when nothing could be read");
});

test("a turn that did not end cleanly pauses the goal instead of continuing it", async () => {
	// 人按停：在做的目标当场停，那一轮随后以 aborted 收尾时不再动它。
	const stopped = driver([verdictText("progress")], {});
	stopped.sut.interrupt();
	await stopped.sut.afterTurn("aborted");
	assert.equal(stopped.state()?.pausedFor, "stopped");
	assert.equal(stopped.asked(), 0);
	await until(() => stopped.events.some((event) => event.type === "notice"), "the pause is announced");
	assert.equal(stopped.events.filter((event) => event.type === "notice").length, 1, "paused once, not twice");
	// 会话为让人插话或编辑重发而停下的那一轮：人开口了，目标让路，不停也不判，等那一轮收尾再判。
	const interjected = driver([verdictText("progress")], {});
	await interjected.sut.afterTurn("aborted");
	assert.equal(interjected.state()?.status, "working");
	assert.equal(interjected.asked(), 0);
	const errored = driver([verdictText("progress")], {});
	await errored.sut.afterTurn("error");
	assert.equal(errored.state()?.pausedFor, "error");
	// 在等的时候按停：不再醒来。
	const waiting = driver([], { status: "waiting", wakeAt: Date.now() + 10 });
	waiting.sut.arm();
	waiting.sut.interrupt();
	assert.equal(waiting.state()?.pausedFor, "stopped");
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(waiting.continued.length, 0);
});

test("a verdict for a goal that was replaced or cleared meanwhile is dropped", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const d = driver([verdictText("met")], {});
	const slow = d.sut as unknown as { deps: GoalDeps };
	const stream = slow.deps.stream!;
	slow.deps.stream = (provider, model, context, options) => {
		// oxlint-disable-next-line require-yield
		return (async function* () { await gate; return (await stream(provider, model, context, options).next()).value as AssistantMessage; })();
	};
	const pending = d.sut.afterTurn("done");
	await until(() => d.state()?.status === "judging", "asking");
	await d.sut.clear();
	release();
	await pending;
	assert.equal(d.state(), undefined, "cleared stays cleared");
	assert.equal(d.events.filter((event) => event.type === "notice").length, 0);
});

test("the system prompt carries the goal only while it is set", async () => {
	const base = { cwd: "/tmp", tools: [], skills: [], projectInstructions: [], platform: "linux", modelName: "m", isGitRepo: false };
	assert.doesNotMatch(await buildSystemPrompt(base), /standing goal/);
	assert.match(await buildSystemPrompt({ ...base, goal: "CI green" }), /A standing goal is set for this conversation: CI green/);
});

test("in a real session: /goal runs a turn, the judge continues it once, then calls it met", { timeout: 10_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "ly-goal-"));
	const home = join(root, "home");
	await mkdir(home, { recursive: true });
	const store = new SessionStore(home);
	try {
		const meta = await store.create(root, MODEL.id);
		const events: AgentEvent[] = [];
		const turns: string[] = [];
		const verdicts = [verdictText("progress", "one more"), verdictText("met", "done")];
		let judged = 0;
		const session = new AgentSession({
			cwd: root, store, meta, settings: SETTINGS,
			emit: (event) => { events.push(event); },
			streamFn: async (context) => {
				// 环境块跟在人的话后面；要的是人（或运行时）说的那句。
				const spoken = context.messages.filter((message) => message.role === "user").map((message) => message.content.map((block) => (block.type === "text" ? block.text : "")).join("")).filter((text) => !text.startsWith("<env>"));
				turns.push(spoken.at(-1) ?? "?");
				assert.match(context.systemPrompt, /standing goal.*CI green/);
				return reply(`turn ${turns.length}`);
			},
			titleSummaryStream: (_provider, _model, context) => {
				assert.equal(context.systemPrompt, GOAL_JUDGE_SYSTEM);
				// oxlint-disable-next-line require-yield
				return (async function* () { return reply(verdicts[Math.min(judged++, verdicts.length - 1)]); })();
			},
		});
		await session.setGoal("CI green");
		await until(() => session.meta.goal?.status === "met", "the goal ends met");
		assert.equal(turns.length, 2);
		assert.equal(turns[0], "CI green");
		assert.match(turns[1], /Goal check: not reached yet\. one more/);
		const synthetic = session.messages.filter((message) => message.role === "user" && message.synthetic);
		assert.equal(synthetic.length, 1, "the continuation is the runtime speaking, not the user");
		assert.equal(session.meta.goal?.rounds, 2);
		assert.deepEqual(events.filter((event) => event.type === "goal").map((event) => (event as { goal: GoalState | null }).goal?.status), ["working", "judging", "working", "judging", "met"]);
		assert.equal(events.findLast((event) => event.type === "notice")?.code, "goal-met");
		const loaded = await store.load(meta.id);
		assert.equal(loaded?.meta.goal?.status, "met", "the state is on disk");
		await session.setGoal(null);
		assert.equal(session.meta.goal, undefined);
		assert.equal((await store.load(meta.id))?.meta.goal, undefined, "cleared on disk too");
		await session.dispose();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

/** 让某个依赖挂起，直到测试放行。 */
function gate() {
	let release!: () => void;
	const opened = new Promise<void>((resolve) => { release = resolve; });
	return { opened, release };
}

test("a stop pressed after a done turn, while waiting for the session to go idle, is not lost", async () => {
	const idle = gate();
	const d = driver([verdictText("progress")], {});
	d.deps.whenIdle = () => idle.opened;
	const pending = d.sut.afterTurn("done");
	// 这一轮已经 done 收尾，状态还是「在做」，正等着排着的先走。
	assert.equal(d.state()?.status, "working");
	d.sut.interrupt();
	idle.release();
	await pending;
	assert.equal(d.state()?.status, "paused");
	assert.equal(d.state()?.pausedFor, "stopped");
	assert.equal(d.asked(), 0, "the judge is not asked");
	assert.equal(d.continued.length, 0);
});

test("a stop pressed while the judge is out, or between its verdict and the next turn, wins", async () => {
	// 裁判还没答：答回来的结论作废。
	const answer = gate();
	const judging = driver([verdictText("progress")], {});
	const stream = judging.deps.stream!;
	judging.deps.stream = (provider, model, context, options) => {
		// oxlint-disable-next-line require-yield
		return (async function* () { await answer.opened; return (await stream(provider, model, context, options).next()).value as AssistantMessage; })();
	};
	const asking = judging.sut.afterTurn("done");
	await until(() => judging.state()?.status === "judging", "asking");
	judging.sut.interrupt();
	answer.release();
	await asking;
	assert.equal(judging.state()?.pausedFor, "stopped");
	assert.equal(judging.continued.length, 0);

	// 结论是「有进展」、正把「在做」写回磁盘：写完不再开下一轮。
	const write = gate();
	const resuming = driver([verdictText("progress")], {});
	const record = resuming.deps.record;
	resuming.deps.record = async (next) => {
		await record(next);
		if (next?.status === "working" && next.rounds === 1) await write.opened;
	};
	const continuing = resuming.sut.afterTurn("done");
	await until(() => resuming.state()?.status === "working" && resuming.state()?.rounds === 1, "writing the continuation");
	resuming.sut.interrupt();
	write.release();
	await continuing;
	assert.equal(resuming.state()?.pausedFor, "stopped");
	assert.equal(resuming.continued.length, 0, "the next turn is not started");
});

test("a waiting goal survives disposal: closing the session is not a stop", async () => {
	const d = driver([], { status: "waiting", wakeAt: Date.now() + 60_000 });
	d.sut.arm();
	d.sut.dispose();
	d.sut.interrupt();
	assert.equal(d.state()?.status, "waiting", "left on disk to be re-armed on the next start");
});
