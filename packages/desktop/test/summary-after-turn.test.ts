/**
 * 环境卡片的摘要什么时候在后台生成：一轮结束、静下来一阵后要一次，下一轮开始就撤掉。
 *
 * 原先由卡片开着时去要，点开旧会话就立刻花一次；现在只跟「刚干完一段活」走，见
 * `electron/session-summary.ts` 的 `summarizeAfterTurn`。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { summarizeAfterTurn } from "../electron/session-summary.ts";

const IDLE = 40;

function harness(busy = () => false) {
	const ran: string[] = [];
	const after = summarizeAfterTurn({ busy, run: async (id) => void ran.push(id), idleMs: IDLE });
	return { ran, after };
}

test("一轮结束、静够了才要，不是结束那一刻就要", async () => {
	const { ran, after } = harness();
	after.observe("a", { type: "agent_end", reason: "done" });
	await sleep(IDLE / 2);
	assert.deepEqual(ran, []);
	await sleep(IDLE);
	assert.deepEqual(ran, ["a"]);
});

test("静的这段时间里下一轮开始了，就不要；那一轮结束后重新计时，只要一次", async () => {
	const { ran, after } = harness();
	after.observe("a", { type: "agent_end", reason: "done" });
	await sleep(IDLE / 2);
	after.observe("a", { type: "agent_start", sessionId: "a" });
	await sleep(IDLE);
	assert.deepEqual(ran, []);
	after.observe("a", { type: "agent_end", reason: "aborted" });
	await sleep(IDLE * 2);
	assert.deepEqual(ran, ["a"]);
});

test("到点时会话还在跑就不要；各会话的计时互不相干", async () => {
	const { ran, after } = harness((id) => id === "busy");
	after.observe("busy", { type: "agent_end", reason: "done" });
	after.observe("b", { type: "agent_end", reason: "done" });
	after.observe("b", { type: "message_end", message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 } } as never);
	await sleep(IDLE * 2);
	assert.deepEqual(ran, ["b"]);
});
