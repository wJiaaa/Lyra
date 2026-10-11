/**
 * The concurrency limit on delegation.
 *
 * Twelve parallel dispatches look like the system working hard right up until the bill. That only
 * the main conversation dispatches at all is pinned in `sub-agent-no-nesting.test.ts`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	concurrencyNote,
	DispatchCancelled,
	DispatchGate,
	MAX_CONCURRENT_SUB_AGENTS,
	normalizeMaxConcurrentSubAgents,
} from "../src/runtime/dispatch-guard.ts";

test("the gate runs up to the limit at once and queues the rest", async () => {
	const gate = new DispatchGate(2);
	const order: string[] = [];
	const release: (() => void)[] = [];

	const start = (name: string) =>
		gate.run(async () => {
			order.push(`start:${name}`);
			await new Promise<void>((resolve) => release.push(resolve));
			order.push(`end:${name}`);
		});

	const a = start("a");
	const b = start("b");
	const c = start("c");
	await new Promise((r) => setTimeout(r, 0));

	assert.deepEqual(order, ["start:a", "start:b"], "the third waited");
	assert.equal(gate.running, 2);
	assert.equal(gate.queued, 1);

	release.shift()!();
	await a;
	await new Promise((r) => setTimeout(r, 0));
	assert.ok(order.includes("start:c"), "finishing one lets the queued one in");

	release.forEach((fn) => fn());
	await Promise.all([b, c]);
	assert.equal(gate.running, 0);
});

test("a throw releases the slot", async () => {
	const gate = new DispatchGate(1);
	await assert.rejects(() =>
		gate.run(async () => {
			throw new Error("boom");
		}),
	);
	assert.equal(gate.running, 0, "a failed dispatch must not permanently consume a slot");
	await gate.run(async () => {});
});

test("the prompt note states the number, because a queue is invisible from inside", () => {
	const note = concurrencyNote(4);
	assert.match(note, /最多 4 个子代理同时跑/);
	assert.match(note, /自动排队/, "it says the queue is the gate's job, not the model's");
	assert.match(note, /子代理自己不能再派子代理/, "the model splitting the work knows it cannot hand the splitting down");
	assert.ok(!/嵌套/.test(note), `no depth to promise any more: ${note}`);
});

test("并发说明叫模型一起派，而不是一轮只派一个——闸门开到 1 的时候尤其", () => {
	/*
	 * 从前这句是「一次派超过 N 个只会让结果更晚到」。闸门开到 1 时，模型读到的是「一次只派一个」：
	 * 四个审查子代理被排成一串，每两个之间隔一整轮主模型的请求（2026-09-26 的真实会话）。
	 */
	const note = concurrencyNote(1);
	assert.match(note, /同一条回复里一起派/);
	assert.match(note, /别为了等前一个的结果而一轮只派一个/);
	assert.ok(!/更晚到|不会更快/.test(note), `不再劝它少派：${note}`);
});

test("排着的时候被叫停，当场离队——之后前面的跑完，它也不会被放进来", async () => {
	/*
	 * 从前闸门听不到停止：整轮被停的时候，排在后面的那几个会在前面的跑完之后照样被放进来，对着
	 * 一个已经停下的会话开跑。
	 */
	const gate = new DispatchGate(1);
	const holding = await gate.acquire();
	const stop = new AbortController();
	const waiting = gate.acquire(stop.signal);
	assert.equal(gate.queued, 1);
	stop.abort("stopped");
	await assert.rejects(waiting, (error: unknown) => error instanceof DispatchCancelled && error.reason === "stopped");
	assert.equal(gate.queued, 0, "离队了");

	holding();
	assert.equal(gate.running, 0, "前面的跑完，名额空着，没有人被放进来");
});

test("已经停下的信号根本排不进去", async () => {
	const gate = new DispatchGate(1);
	await gate.acquire();
	const stop = new AbortController();
	stop.abort();
	await assert.rejects(gate.acquire(stop.signal), DispatchCancelled);
	assert.equal(gate.queued, 0);
});

test("名额还两次也只算一次", async () => {
	const gate = new DispatchGate(2);
	const release = await gate.acquire();
	await gate.acquire();
	release();
	release();
	assert.equal(gate.running, 1, "多还的那一次不该凭空多出一个空位");
});

test("停止落在排队中的派发上：出队、不跑、不占名额", async () => {
	/*
	 * 以前排队不看停止信号：人按了停，只有已经登记在册的那几个被停下，排在后面的照样一个个被
	 * 放进来、从头跑完。
	 */
	const gate = new DispatchGate(1);
	let release!: () => void;
	const first = gate.run(() => new Promise<void>((resolve) => (release = resolve)));
	const stop = new AbortController();
	let ran = false;
	const queued = gate.run(async () => {
		ran = true;
	}, stop.signal);
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(gate.queued, 1);

	stop.abort();
	await assert.rejects(queued);
	assert.equal(gate.queued, 0, "停下的那个离开了队列");
	assert.equal(gate.running, 1, "它从没拿到名额，也就没有名额要还");

	release();
	await first;
	assert.equal(ran, false, "前面的跑完放人时，它已经不在队里了");
	assert.equal(gate.running, 0);
});

test("已经停了的信号不进闸门；放行之后、开跑之前停下的也不跑，名额当场还回去", async () => {
	const gate = new DispatchGate(1);
	const stopped = AbortSignal.abort();
	await assert.rejects(gate.run(async () => assert.fail("不该开跑"), stopped));
	assert.equal(gate.running, 0);

	// 放行（记账）和醒来之间隔着一个微任务：`setLimit` 同步放人，紧接着同步停下。
	let release!: () => void;
	const first = gate.run(() => new Promise<void>((resolve) => (release = resolve)));
	const stop = new AbortController();
	let ran = false;
	const queued = gate.run(async () => {
		ran = true;
	}, stop.signal);
	await new Promise((r) => setTimeout(r, 0));
	gate.setLimit(2);
	assert.equal(gate.running, 2, "已经放行、名额已记账");
	stop.abort();
	await assert.rejects(queued);
	assert.equal(ran, false);
	assert.equal(gate.running, 1, "被放行又被停下的那个，名额当场还了");
	release();
	await first;
	assert.equal(gate.running, 0);
});

test("磁盘上的并发上限夹在 1–8，负数回落到默认 4", () => {
	assert.equal(MAX_CONCURRENT_SUB_AGENTS, 8);
	assert.equal(normalizeMaxConcurrentSubAgents(-12), 4);
	assert.equal(normalizeMaxConcurrentSubAgents(0), 4);
	assert.equal(normalizeMaxConcurrentSubAgents(Number.NaN), 4);
	assert.equal(normalizeMaxConcurrentSubAgents(3.9), 3);
	assert.equal(normalizeMaxConcurrentSubAgents(8), 8);
	assert.equal(normalizeMaxConcurrentSubAgents(16), 8, "旧文件里的 16 不能再穿过去");
});

test("闸门在对话中途收窄：正在跑的不打断，新的要排队", async () => {
	const gate = new DispatchGate(4);
	const release: (() => void)[] = [];
	const running: string[] = [];
	const start = (name: string) =>
		gate.run(async () => {
			running.push(name);
			await new Promise<void>((resolve) => release.push(resolve));
		});

	const first = [start("a"), start("b"), start("c")];
	await new Promise((r) => setTimeout(r, 0));
	assert.deepEqual(running, ["a", "b", "c"]);

	// 用户在会话中途把配置里的并发上限从 4 改成 2。
	gate.setLimit(2);
	assert.equal(gate.running, 3, "已经在跑的三个不该被腰斩——半截的活加一次白花的调用");

	const later = start("d");
	await new Promise((r) => setTimeout(r, 0));
	assert.ok(!running.includes("d"), "新的那个要等到跌回新宽度以下");

	release.shift()!();
	await first[0];
	await new Promise((r) => setTimeout(r, 0));
	assert.ok(!running.includes("d"), "还剩两个在跑，正好卡在新宽度上");

	release.shift()!();
	await first[1];
	await new Promise((r) => setTimeout(r, 0));
	assert.ok(running.includes("d"), "跌到 1 个了，该放它进来");

	release.forEach((fn) => fn());
	await Promise.all([...first, later]);
	assert.equal(gate.running, 0);
});

test("闸门放宽时立刻放人，不用等谁跑完", async () => {
	const gate = new DispatchGate(1);
	const release: (() => void)[] = [];
	const running: string[] = [];
	const start = (name: string) =>
		gate.run(async () => {
			running.push(name);
			await new Promise<void>((resolve) => release.push(resolve));
		});

	const all = [start("a"), start("b"), start("c"), start("d")];
	await new Promise((r) => setTimeout(r, 0));
	assert.deepEqual(running, ["a"]);
	assert.equal(gate.queued, 3);

	gate.setLimit(3);
	await new Promise((r) => setTimeout(r, 0));
	assert.deepEqual(running, ["a", "b", "c"], "位置变多了，队列该立刻动");
	assert.equal(gate.running, 3, "一次放多个也不能记错账");
	assert.equal(gate.queued, 1);

	release.forEach((fn) => fn());
	await new Promise((r) => setTimeout(r, 0));
	release.forEach((fn) => fn());
	await Promise.all(all);
	assert.equal(gate.running, 0, "放宽过的闸门，名额还是要一个不少地还回来");
	assert.equal(gate.width, 3);
});

test("反复改宽度不会把名额算漏或算重", async () => {
	const gate = new DispatchGate(2);
	const release: (() => void)[] = [];
	const done: string[] = [];
	const jobs = Array.from({ length: 10 }, (_, i) =>
		gate.run(async () => {
			await new Promise<void>((resolve) => release.push(resolve));
			done.push(String(i));
		}),
	);

	for (const width of [1, 5, 2, 8, 3]) {
		gate.setLimit(width);
		await new Promise((r) => setTimeout(r, 0));
		assert.ok(gate.running <= Math.max(width, 0) || gate.running <= 8, "在跑的不该超过刚放宽到的宽度");
	}

	while (release.length > 0 || done.length < 10) {
		release.splice(0).forEach((fn) => fn());
		await new Promise((r) => setTimeout(r, 0));
	}
	await Promise.all(jobs);
	assert.equal(done.length, 10, "十个都要跑完，一个都不能卡在队列里");
	assert.equal(gate.running, 0);
	assert.equal(gate.queued, 0);
});
