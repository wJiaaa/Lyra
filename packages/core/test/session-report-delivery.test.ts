/**
 * 从建议卡片上开出来、要求交回的会话，第一轮的回复回到提建议的那个对话：和子代理的结果同一条送达。
 *
 * 守着三件事：给模型的那一份说清这是哪个会话、还在、该怎么接；给界面的那一份是 `kind: "session"`，
 * 不会被当成子代理画出一张脸；人按了停，攒着的那一份不再送——和子代理的结果一样。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { deliveryMessage } from "../src/runtime/sub-agent/delegation-waits.ts";
import { SessionDeliveries } from "../src/runtime/session-deliveries.ts";
import type { Message } from "../src/types.ts";

const textOf = (message: Message) => message.content.map((part) => ("text" in part ? part.text : "")).join("");
const REPORT = { sessionId: "s-child", title: "补上 \"使用说明\"", status: "done" as const, reply: "文档补在 docs/guide/usage.md。" };

test("送达消息：交回的会话有自己的标签和种类，给界面的那一份不带回复正文", () => {
	const message = deliveryMessage([], [], [], [REPORT, { ...REPORT, sessionId: "s-other", status: "failed", reply: "" }]);
	const text = textOf(message);
	assert.match(text, /<session_result id="s-child" title="补上 '使用说明'" status="done">\n文档补在 docs\/guide\/usage.md。/, "标题里的引号不能把标签撑破");
	assert.match(text, /status="failed">\n（它没有留下回复。）/);
	assert.match(text, /那个会话还在/);
	assert.doesNotMatch(text, /子代理有结果了/, "不是子代理");
	assert.deepEqual(message.role === "user" ? message.delivery : null, [
		{ id: "s-child", kind: "session", agent: "", description: "补上 \"使用说明\"", status: "done" },
		{ id: "s-other", kind: "session", agent: "", description: "补上 \"使用说明\"", status: "failed" },
	]);
});

function deliveries() {
	const submitted: Message[] = [];
	let stopped = false;
	const activity = { mark: () => 0, compaction: null, stoppedSince: () => stopped };
	const box = new SessionDeliveries({
		activity: activity as never,
		jobs: () => ({ isQuiet: () => false, observed: () => {} }) as never,
		detail: () => null,
		outstanding: () => [],
		submit: async (message) => { submitted.push(message); },
		settled: () => {},
	});
	return { box, submitted, stop: () => { stopped = true; } };
}

test("攒一下就送成一条；送之前不算空闲", async () => {
	const { box, submitted } = deliveries();
	box.sessionFinished(REPORT);
	assert.equal(box.empty, false, "攒着的那一条四百毫秒后会开一轮");
	await new Promise((resolve) => setTimeout(resolve, 500));
	assert.equal(submitted.length, 1);
	assert.deepEqual(submitted[0].role === "user" ? submitted[0].delivery?.map((one) => one.kind) : null, ["session"]);
	assert.equal(box.empty, true);
});

test("人按了停：攒着的不再送", async () => {
	const { box, submitted } = deliveries();
	box.sessionFinished(REPORT);
	box.clear();
	await new Promise((resolve) => setTimeout(resolve, 500));
	assert.equal(submitted.length, 0);
	assert.equal(box.empty, true);
});
