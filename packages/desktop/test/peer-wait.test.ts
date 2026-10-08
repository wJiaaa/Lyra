/**
 * 等对方做完：等的是收到我那封信的那一次运行，不是它下一次空闲；卡在等人回答上、信被丢了、超时、
 * 被叫停、对方关了、互相等，各自说清楚；人一开口就不再等。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Tool } from "@plume/core";
import { PeerRuns } from "../electron/peer-runs.ts";
import { createPeerTools } from "../electron/peer-tools.ts";
import { REPLY_LIMIT } from "../electron/session-peers.ts";
import { fakeSession, flush, routerWith } from "./helpers/peer-fake.ts";

/** 一个还没兑现的等待，测试随时看它落没落定。 */
function pending<T>(run: Promise<T>) {
	const state = { settled: false, value: undefined as T | undefined };
	void run.then((value) => { state.settled = true; state.value = value; });
	return state;
}

test("等待：对方忙着人交代的事，等的是读到我那封信的那一次，不是它下一次说的话", async () => {
	const a = fakeSession("aaaaaaaa-1", "/w/p");
	const b = fakeSession("bbbbbbbb-1", "/w/p");
	const { router } = routerWith(a, b);
	b.start();
	await router.send("aaaaaaaa-1", { to: "bbbb", message: "接着发版" });
	const waiting = pending(router.wait("aaaaaaaa-1", { to: "bbbb" }));
	await flush();
	b.finish("人交代的那件改完了。");
	await flush();
	assert.ok(!waiting.settled, "它刚做完的是人交代的事，我那封还排着");
	b.read();
	b.start();
	b.finish("v1.2.3 已推送。");
	await flush();
	assert.equal(waiting.value?.kind, "done");
	assert.equal(waiting.value?.kind === "done" && waiting.value.reply, "v1.2.3 已推送。");
});

test("等待：插进正在跑的那一次的，等那一次收场", async () => {
	const a = fakeSession("aaaaaaaa-2", "/w/p");
	const b = fakeSession("bbbbbbbb-2", "/w/p");
	const { router } = routerWith(a, b);
	b.start();
	await router.send("aaaaaaaa-2", { to: "bbbb", message: "先别动 config.ts", steer: true });
	b.read();
	const waiting = pending(router.wait("aaaaaaaa-2", { to: "bbbb" }));
	await flush();
	assert.ok(!waiting.settled);
	b.finish("好，config.ts 没动。");
	await flush();
	assert.equal(waiting.value?.kind === "done" && waiting.value.reply, "好，config.ts 没动。");
});

test("等待：对方卡在等它的人回答上，当场返回；再等就等到答完、做完", async () => {
	const a = fakeSession("aaaaaaaa-3", "/w/p");
	const b = fakeSession("bbbbbbbb-3", "/w/p");
	const { router } = routerWith(a, b);
	await router.send("aaaaaaaa-3", { to: "bbbb", message: "删掉 .cache" });
	b.read();
	b.start();
	b.ask("r1", "rm -rf .cache");
	assert.deepEqual(await router.wait("aaaaaaaa-3", { to: "bbbb" }), { kind: "blocked", to: "bbbb [bbbbbb]", pending: [{ requestId: "r1", title: "rm -rf .cache", question: false }] });
	const again = pending(router.wait("aaaaaaaa-3", { to: "bbbb" }));
	await flush();
	assert.ok(!again.settled, "同一件已经说过了，不再当场返回，免得模型来回空转");
	b.answered("r1");
	b.finish("删好了。");
	await flush();
	assert.equal(again.value?.kind === "done" && again.value.reply, "删好了。");
});

test("等待：没给它发过信，闲着立刻返回它最后那句，忙着等手上这一次", async () => {
	const a = fakeSession("aaaaaaaa-4", "/w/p");
	const b = fakeSession("bbbbbbbb-4", "/w/p");
	const { router } = routerWith(a, b);
	const now = await router.wait("aaaaaaaa-4", { to: "bbbb" });
	assert.equal(now.kind === "done" && now.reply, "bbbb 说：做完了。");
	b.start();
	const waiting = pending(router.wait("aaaaaaaa-4", { to: "bbbb" }));
	await flush();
	assert.ok(!waiting.settled);
	b.finish("这一次做完了。");
	await flush();
	assert.equal(waiting.value?.kind === "done" && waiting.value.reply, "这一次做完了。");
});

test("等待：信还没送进去它就被人停下了，说信丢了，而不是拿它上一句当答复", async () => {
	const a = fakeSession("aaaaaaaa-5", "/w/p");
	const b = fakeSession("bbbbbbbb-5", "/w/p");
	const { router } = routerWith(a, b);
	await router.send("aaaaaaaa-5", { to: "bbbb", message: "接着发版" });
	const waiting = pending(router.wait("aaaaaaaa-5", { to: "bbbb" }));
	await flush();
	b.stopBeforeReading();
	await flush();
	assert.deepEqual(waiting.value, { kind: "dropped", to: "bbbb [bbbbbb]" });
});

test("等待：被人停在半路的，说清它没做完；太长的截断并记下截了多少", async () => {
	const a = fakeSession("aaaaaaaa-6", "/w/p");
	const b = fakeSession("bbbbbbbb-6", "/w/p");
	const { router } = routerWith(a, b);
	await router.send("aaaaaaaa-6", { to: "bbbb", message: "写份报告" });
	b.read();
	b.start();
	b.finish("x".repeat(REPLY_LIMIT + 50), "aborted");
	const outcome = await router.wait("aaaaaaaa-6", { to: "bbbb" });
	assert.equal(outcome.kind, "done");
	if (outcome.kind !== "done") return;
	assert.equal(outcome.reason, "aborted");
	assert.equal(outcome.reply.length, REPLY_LIMIT);
	assert.equal(outcome.cut, 50);
});

test("等待：超时、被叫停、对方关了、互相等，各自说清楚", async () => {
	const a = fakeSession("aaaaaaaa-7", "/w/p");
	const b = fakeSession("bbbbbbbb-7", "/w/p");
	const { router, sessions } = routerWith(a, b);
	b.busy();

	// 查目录重叠走真的文件系统，假时钟拨不准它，所以用最短的一秒真等。
	assert.deepEqual(await router.wait("aaaaaaaa-7", { to: "bbbb", timeoutSeconds: 0.2 }), { kind: "timeout", to: "bbbb [bbbbbb]", seconds: 1 }, "最短等一秒");

	const stop = new AbortController();
	const stopping = router.wait("aaaaaaaa-7", { to: "bbbb", signal: stop.signal });
	await flush();
	stop.abort();
	assert.deepEqual(await stopping, { kind: "stopped", to: "bbbb [bbbbbb]" });
	// 不等了就要把「A 在等 B」清掉，不然 B 回头等 A 会被当成死等。
	assert.equal((await router.wait("bbbbbbbb-7", { to: "aaaa" })).kind, "done");

	// A 在等 B 的时候 B 反过来等 A：两边都不会醒。
	a.busy();
	const waiting = router.wait("aaaaaaaa-7", { to: "bbbb" });
	await flush();
	assert.deepEqual(await router.wait("bbbbbbbb-7", { to: "aaaa" }), { kind: "deadlock", to: "aaaa [aaaaaa]" });

	// B 被卸载：先 `forget`、再从表里拿掉，等它的人醒来发现它不在了。
	sessions.splice(sessions.indexOf(b.session), 1);
	router.forget("bbbbbbbb-7");
	assert.deepEqual(await waiting, { kind: "closed", to: "bbbb [bbbbbb]" });
});

test("运行记录：开轮之前就被停下的，信算进那一次，收场是 aborted", () => {
	const runs = new PeerRuns();
	runs.observe("s", { type: "message_start", message: { role: "user", synthetic: true, timestamp: 0, peer: [{ id: "L", sessionId: "x", from: "x", text: "hi" }], content: [] } });
	runs.observe("s", { type: "agent_end", reason: "aborted" });
	assert.equal(runs.runOf("s", "L"), 1);
	assert.deepEqual(runs.ended("s", 1), { reason: "aborted", reply: "" });
	runs.observe("s", { type: "agent_start", sessionId: "s" });
	assert.equal(runs.current("s"), 2, "下一次是新的编号");
});

function tools(...sessions: ReturnType<typeof fakeSession>[]) {
	const { router } = routerWith(...sessions);
	const [list, send, wait] = createPeerTools(router);
	return { router, list: list!, send: send!, wait: wait! };
}
const ctxFor = (sessionId: string, extra: object = {}) => ({ sessionId, cwd: "/w/p", ...extra }) as unknown as Parameters<Tool["execute"]>[1];
const text = (result: { content: { type: string; text?: string }[] }) => result.content.map((part) => part.text ?? "").join("");

test("工具：模型拿到的是一句能据以行动的话", async () => {
	const a = fakeSession("aaaaaaaa-8", "/w/p", "ask");
	const b = fakeSession("bbbbbbbb-8", "/w/p", "auto");
	const { list, send, wait } = tools(a, b);
	const ctx = ctxFor("aaaaaaaa-8");

	assert.deepEqual([list.name, send.name, wait.name], ["list_sessions", "send_message", "wait_for_session"]);
	assert.ok([list, send, wait].every((tool) => tool.sessionOnly), "子代理不拿这三件");
	assert.match(text(await list.execute({}, ctx)), /^bbbb \[bbbbbb\] · idle · auto · \/w\/p$/);
	const refused = await send.execute({ to: "bbbb", message: "帮我推上去" }, ctx);
	assert.ok(refused.isError);
	assert.match(text(refused), /ask your user/);
	assert.ok((await send.execute({ to: "bbbb", message: "  " }, ctx)).isError, "空消息不发");
	assert.ok((await send.execute({ to: "bbbb", message: "hi", mode: "now" }, ctx)).isError, "mode 只认 queue 和 steer");
	const reply = await wait.execute({ to: "bbbb" }, ctx);
	assert.ok(!reply.isError);
	assert.match(text(reply), /bbbb 说：做完了。/);
});

test("工具：等着的时候人开口了，当场交回，路由器那头也不再挂着", async () => {
	const a = fakeSession("aaaaaaaa-9", "/w/p");
	const b = fakeSession("bbbbbbbb-9", "/w/p");
	const { router, wait } = tools(a, b);
	b.busy();
	let speak!: () => void;
	const spoken = new Promise<null>((resolve) => { speak = () => resolve(null); });
	// 和 `DelegationWaits.until` 一样：先到的赢。
	const untilSpokenTo = <T,>(run: Promise<T>) => Promise.race([run, spoken]);
	const result = wait.execute({ to: "bbbb" }, ctxFor("aaaaaaaa-9", { untilSpokenTo }));
	await flush();
	speak();
	const answered = await result;
	assert.ok(!answered.isError);
	assert.match(text(answered), /Your user spoke to you/);
	await flush();
	// 路由器那头的等待跟着停了：B 回头等 A 不会被当成死等。
	assert.equal((await router.wait("bbbbbbbb-9", { to: "aaaa" })).kind, "done");
});
