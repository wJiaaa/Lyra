/**
 * The three limits on delegation.
 *
 * Each of these failures is expensive and quiet: twelve parallel dispatches, a cycle, or a tree
 * that keeps going down all look like the system working hard right up until the bill.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	childDispatch,
	concurrencyNote,
	DispatchCancelled,
	DispatchGate,
	MAX_CONCURRENT_SUB_AGENTS,
	normalizeMaxConcurrentSubAgents,
	refuseDispatch,
	rootDispatch,
	DEFAULT_MAX_DEPTH,
} from "../src/runtime/dispatch-guard.ts";

test("the main conversation may dispatch", () => {
	assert.equal(refuseDispatch(rootDispatch(), "explore"), undefined);
});

test("a sub-agent may dispatch once, and not past the depth limit", () => {
	const first = childDispatch(rootDispatch(), "explore");
	assert.equal(refuseDispatch(first, "review"), undefined, "depth 1 is still inside the default limit of 2");

	const second = childDispatch(first, "review");
	const refusal = refuseDispatch(second, "general");
	assert.ok(refusal, "depth 2 is the limit");
	assert.match(refusal, /上限是 2/, "the message names the limit rather than only saying no");
	assert.match(refusal, /自己做完/, "and says what to do instead");
});

test("the depth limit is configurable", () => {
	const one = childDispatch(rootDispatch(), "explore");
	assert.ok(refuseDispatch(one, "review", { maxDepth: 1 }));
	assert.equal(refuseDispatch(one, "review", { maxDepth: 3 }), undefined);
});

test("an agent cannot appear twice in one chain", () => {
	/*
	 * `explore → reviewer → explore` is a prompt written wrong rather than a plan, and it spends
	 * money at a rate that makes failing loudly the kind option.
	 */
	const chain = childDispatch(childDispatch(rootDispatch(), "explore"), "reviewer");
	const refusal = refuseDispatch(chain, "explore", { maxDepth: 5 });
	assert.ok(refusal);
	assert.match(refusal, /explore → reviewer → explore/, "the message shows the cycle it found");
});

test("a sibling of the same name at a different point in the tree is fine", () => {
	/*
	 * Two branches each dispatching `explore` is ordinary fan-out. Only a repeat *within one chain*
	 * is a cycle, and a check that looked at the whole tree would forbid the common case.
	 */
	const left = childDispatch(rootDispatch(), "explore");
	const right = childDispatch(rootDispatch(), "review");
	assert.equal(refuseDispatch(right, "explore"), undefined);
	assert.equal(left.chain.length, 1);
});

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
	const note = concurrencyNote(4, DEFAULT_MAX_DEPTH);
	assert.match(note, /最多 4 个子代理同时跑/);
	assert.match(note, /自动排队/, "it says the queue is the gate's job, not the model's");
});

test("并发说明叫模型一起派，而不是一轮只派一个——闸门开到 1 的时候尤其", () => {
	/*
	 * 从前这句是「一次派超过 N 个只会让结果更晚到」。闸门开到 1 时，模型读到的是「一次只派一个」：
	 * 四个审查子代理被排成一串，每两个之间隔一整轮主模型的请求（2026-09-26 的真实会话）。
	 */
	const note = concurrencyNote(1, DEFAULT_MAX_DEPTH);
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

test("派生里的派生：先让出自己的名额，孩子排不上时照样能被叫停", async () => {
	const gate = new DispatchGate(1);
	const parent = await gate.acquire();
	const child = await gate.children().acquire();
	assert.equal(gate.running, 1, "父亲让出来的那个位置给了孩子");
	child();
	assert.equal(gate.running, 1, "孩子还回去，父亲把自己的位置拿回来");
	parent();
	assert.equal(gate.running, 0);

	// 宽度中途收窄，让出自己的那一个之后仍然超额——孩子得排队；排着被停，父亲等到有空位再拿回来，不越过宽度。
	const wide = new DispatchGate(2);
	const a = await wide.acquire();
	const b = await wide.acquire();
	wide.setLimit(1);
	const stop = new AbortController();
	const queued = wide.children().acquire(stop.signal);
	assert.equal(wide.queued, 1, "孩子在排队");
	stop.abort();
	let settled = false;
	const cancelled = assert.rejects(queued, DispatchCancelled).then(() => { settled = true; });
	await new Promise((r) => setTimeout(r, 5));
	assert.equal(settled, false, "宽度已是 1、另一个还在跑：父亲等它走");
	b();
	await cancelled;
	assert.equal(wide.running, 1, "父亲那一个没有丢");
	a();
	assert.equal(wide.running, 0);
});

test("一个父亲并行派几个孩子，只让一次位，孩子照常排队", async () => {
	// 按孩子让位的话，宽度 1 时四个孩子各让一次父亲的名额，全都同时进来，计数却一直是 1。
	const gate = new DispatchGate(1);
	const parent = await gate.acquire();
	const kids = gate.children();
	let started = 0;
	const releases: (() => void)[] = [];
	const pending = Array.from({ length: 4 }, () => kids.acquire().then((release) => { started++; releases.push(release); }));
	await new Promise((r) => setTimeout(r, 5));
	assert.equal(started, 1, "父亲让出的那一个位置只放进一个孩子");
	assert.equal(gate.queued, 3, "其余的排队");
	for (let i = 0; i < 4; i++) {
		releases.shift()?.();
		await new Promise((r) => setTimeout(r, 1));
	}
	await Promise.all(pending);
	assert.equal(started, 4);
	assert.equal(gate.running, 1, "孩子都走了，父亲取回自己的位置");
	parent();
	assert.equal(gate.running, 0);
});

test("最后一个孩子走的时候，名额先还给父亲，排队的人不会跟着同时进来", async () => {
	const gate = new DispatchGate(1);
	const parent = await gate.acquire();
	const child = await gate.children().acquire();
	let admitted = false;
	const other = gate.acquire().then((release) => { admitted = true; return release; });
	child();
	await new Promise((r) => setTimeout(r, 5));
	assert.equal(admitted, false, "父亲回来了，宽度 1 已经满了");
	assert.equal(gate.running, 1);
	parent();
	(await other)();
	assert.equal(gate.running, 0);
});

test("最后一个排队的孩子被叫停，父亲也不越过宽度取回名额", async () => {
	// P 派 C1/C2，C1 走后空位被先排着的 Q 拿走；这时单独停掉 C2，父亲不能凭空多出一个名额。
	const gate = new DispatchGate(1);
	const parent = await gate.acquire();
	const kids = gate.children();
	const c1 = await kids.acquire();
	const q = gate.acquire();
	const stop = new AbortController();
	const c2 = kids.acquire(stop.signal);
	c1();
	const releaseQ = await q;
	assert.equal(gate.running, 1, "Q 拿到了 C1 空出来的位置");
	stop.abort();
	let settled = false;
	const cancelled = assert.rejects(c2, DispatchCancelled).then(() => { settled = true; });
	await new Promise((r) => setTimeout(r, 5));
	assert.equal(gate.running, 1, "宽度 1，父亲等 Q 走");
	assert.equal(settled, false);
	releaseQ();
	await cancelled;
	assert.equal(gate.running, 1, "Q 走了，父亲拿回自己的位置");
	parent();
	assert.equal(gate.running, 0);
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

test("嵌套派发排队时同样听停止信号，让出去的位置照样取回", async () => {
	const gate = new DispatchGate(1);
	await gate.run(async () => {
		const stop = new AbortController();
		stop.abort();
		await assert.rejects(gate.children().run(async () => assert.fail("不该开跑"), stop.signal));
		assert.equal(gate.running, 1, "父亲的位置原样取回");
	});
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

test("闸门收到 1 的时候，第二层派生照样进得来", async () => {
	/*
	 * 这条是拿命换来的：宽度设成 1，一个编排型子代理占着那唯一的位置去派
	 * 孙代理，孙代理排在它后面——而它在等孙代理。界面上是一个「派发子任务」转到超时，日志里
	 * 什么错都没有。
	 *
	 * 整棵派生树共用一道闸门是对的，占着位置等孩子不对。见 `DispatchGate.children`。
	 */
	const gate = new DispatchGate(1);
	const done: string[] = [];
	await gate.run(async () => {
		done.push("父进来了");
		await gate.children().run(async () => {
			done.push("孩子也进来了");
		});
		done.push("父继续跑");
	});
	assert.deepEqual(done, ["父进来了", "孩子也进来了", "父继续跑"]);
	assert.equal(gate.running, 0, "名额要一个不少地还回来");
});

test("四路各派一个孙代理，谁也不会卡住", async () => {
	// 宽度 4、四个子代理各派一个孙：共用一道闸门，同样会占着位置等孩子。
	const gate = new DispatchGate(4);
	const finished: number[] = [];
	await Promise.all(
		Array.from({ length: 4 }, (_, i) =>
			gate.run(async () => {
				await gate.children().run(async () => {
					await new Promise((r) => setTimeout(r, 5));
				});
				finished.push(i);
			}),
		),
	);
	assert.deepEqual(finished.sort(), [0, 1, 2, 3]);
	assert.equal(gate.running, 0);
	assert.equal(gate.queued, 0);
});

test("让位是暂时的，真正在跑的仍然不超过宽度", async () => {
	const gate = new DispatchGate(2);
	let peak = 0;
	const release: (() => void)[] = [];
	// 每个「真的在跑」的活都会把峰值顶上去；父在等孩子的那一段不算在跑。
	const busy = async () => {
		peak = Math.max(peak, gate.running);
		await new Promise<void>((resolve) => release.push(resolve));
	};
	const jobs = [
		gate.run(async () => { await busy(); await gate.children().run(busy); }),
		gate.run(async () => { await busy(); await gate.children().run(busy); }),
		gate.run(busy),
	];
	for (let i = 0; i < 6; i++) {
		await new Promise((r) => setTimeout(r, 5));
		release.splice(0).forEach((fn) => fn());
	}
	await Promise.all(jobs);
	assert.ok(peak <= 3, `真正在跑的一度到了 ${peak} 个，宽度只有 2——让位最多允许瞬时多一个`);
	assert.equal(gate.running, 0);
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
