/**
 * Picking the work back up when a turn stops before the work does.
 *
 * Two halves. `continueWhileWorkRemains` starts another turn over the history it already has when
 * the rounds run out — and a turn cut off mid-stream must leave a history that is still sendable,
 * so the person's 继续 has something to resume from.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRunResult } from "../src/agent/loop.ts";
import { runAgent } from "../src/agent/loop.ts";
import { runConfig } from "./run-config.ts";
import { continueWhileWorkRemains } from "../src/runtime/continuation.ts";
import { toAnthropicMessages } from "../src/ai/anthropic-messages-request.ts";
import { TODOS_KEY, type TodoItem } from "../src/tools/todo.ts";
import type { AssistantMessage, ModelConfig, ProviderConfig } from "../src/types.ts";
import { emptyUsage } from "../src/types.ts";

const MODEL: ModelConfig = {
	id: "fake/model",
	providerId: "fake",
	modelId: "model",
	name: "Fake",
	contextWindow: 100_000,
	maxOutputTokens: 4096,
	supportsThinking: false,
	supportsImages: false,
	supportsTools: true,
};

const PROVIDER: ProviderConfig = {
	id: "fake",
	name: "Fake",
	baseUrl: "http://localhost",
	api: "anthropic-messages",
	apiKey: "x",
	enabled: true,
	models: [MODEL],
};

function base(): Omit<AssistantMessage, "content"> {
	return {
		role: "assistant",
		api: "anthropic-messages",
		provider: "fake",
		model: "model",
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: 1,
	};
}

const result = (over: Partial<AgentRunResult>): AgentRunResult => ({ messages: [], reason: "done", ...over });

interface Recorded {
	runs: number;
	notices: string[];
}

function deps(script: AgentRunResult[], over: Partial<Parameters<typeof continueWhileWorkRemains>[1]> = {}) {
	const seen: Recorded = { runs: 0, notices: [] };
	const full: Parameters<typeof continueWhileWorkRemains>[1] = {
		run: async () => script[Math.min(seen.runs++, script.length - 1)],
		messages: () => [],
		todos: () => [],
		aborted: () => false,
		notify: (notice) => void seen.notices.push(notice.message),
		...over,
	};
	return { seen, full };
}

/*
 * 断线不整轮重来：请求那一层已经按设置页的次数重试过了，重试用完就交给人点「继续」。
 * 有清单、清单没做完也一样——那是步数上限的判据，不是断线的。
 */
test("a turn the connection killed is left for the person, not picked back up", async () => {
	const dropped = result({ reason: "error", error: "fetch failed (UND_ERR_SOCKET)" });
	const unfinished: TodoItem[] = [{ content: "step", status: "pending" }];
	const { seen, full } = deps([result({ reason: "done" })], { todos: () => unfinished });
	const final = await continueWhileWorkRemains(dropped, full);

	assert.equal(seen.runs, 0);
	assert.equal(final, dropped, "and the failure is what gets reported");
	assert.deepEqual(seen.notices, []);
});

test("running out of rounds still behaves as it did", async () => {
	const capped = result({ reason: "max_turns" });
	const unfinished: TodoItem[] = [{ content: "step", status: "pending" }];
	const { seen, full } = deps([result({ reason: "done" })], { todos: () => unfinished });
	await continueWhileWorkRemains(capped, full);

	assert.equal(seen.runs, 1);
	assert.match(seen.notices[0], /步数用尽/);
});

test("running out of rounds with the plan complete still stops", async () => {
	const { seen, full } = deps([result({ reason: "done" })], { todos: () => [] });
	await continueWhileWorkRemains(result({ reason: "max_turns" }), full);

	assert.match(seen.notices.at(-1) ?? "", /步数上限.*停下/);
	assert.equal(seen.runs, 0);
});

/*
 * 清单上一项都没打勾的续跑，最多给一次。
 *
 * 真实案例：2026-09-15 的 `86ff1d52` 跑了 396 轮、5.32 小时、36.9M token、$10.72，计划始终停在
 * 0/4。当时的条件只问「还有没有没做完的」，而清单是模型自己写的，探索中只增不减，于是永远为真。
 * 重复看门狗也没有拦住它——那 396 次调用里有 384 个不同指纹，它没有任何东西可抓。
 */
test("rounds that finish nothing twice over stop rather than continuing", async () => {
	// 四项，一项都没打勾——两轮下来还是一项都没打勾。
	const stuck: TodoItem[] = [
		{ content: "a", status: "in_progress" },
		{ content: "b", status: "pending" },
		{ content: "c", status: "pending" },
		{ content: "d", status: "pending" },
	];
	const { seen, full } = deps([result({ reason: "max_turns" }), result({ reason: "max_turns" }), result({ reason: "max_turns" })], {
		todos: () => stuck,
	});

	await continueWhileWorkRemains(result({ reason: "max_turns" }), full);

	assert.equal(seen.runs, 1, "第一次零进展还给一次机会，第二次就该停——不是 10 次");
	assert.match(seen.notices[seen.notices.length - 1], /一项都没完成/);
});

test("rounds that keep finishing things keep going", async () => {
	/*
	 * 打勾数每轮 +1：这是真的长任务，不该被上面那条闸误伤。
	 *
	 * 没有这条，上面那条测试可以靠「永远停在第一次续跑」通过——而那会把每一个超过两百步的正经
	 * 任务砍在半路。
	 */
	let ticked = 0;
	const { seen, full } = deps(
		[result({ reason: "max_turns" }), result({ reason: "max_turns" }), result({ reason: "done" })],
		{
			todos: () => [
				{ content: "a", status: ticked > 0 ? "completed" : "pending" },
				{ content: "b", status: ticked > 1 ? "completed" : "pending" },
				{ content: "c", status: ticked > 2 ? "completed" : "pending" },
				{ content: "d", status: "pending" },
			],
			run: async () => {
				ticked += 1;
				return [result({ reason: "max_turns" }), result({ reason: "max_turns" }), result({ reason: "done" })][
					Math.min(seen.runs++, 2)
				];
			},
		},
	);

	await continueWhileWorkRemains(result({ reason: "max_turns" }), full);

	assert.equal(seen.runs, 3, "每一轮都打上了勾，就一直继续到它自己说做完了");
	assert.ok(
		!seen.notices.some((notice) => /一项都没完成/.test(notice)),
		"有进展的轮次不该收到停下来的通知",
	);
});

// ---------------------------------------------------------------------------
// A cut-off turn must leave a history the provider will accept, or 继续 has nothing to send
// ---------------------------------------------------------------------------

const interrupted = (stopReason: "error" | "aborted"): AssistantMessage => ({
	...base(),
	stopReason,
	...(stopReason === "error" ? { errorMessage: "fetch failed (UND_ERR_SOCKET)", errorRetryable: true } : {}),
	// Half a call: the stream carried the name and then stopped.
	content: [{ type: "toolCall", id: "call-1", name: "write_file", arguments: {}, argumentsText: '{"path":' }],
});

async function runInterrupted(stopReason: "error" | "aborted") {
	return runAgent(
		runConfig({
			session: {
				sessionId: "test",
				messages: [{ role: "user", content: [{ type: "text", text: "write the file" }], timestamp: 1 }],
				state: new Map<string, unknown>([[TODOS_KEY, []]]),
			},
			model: { provider: PROVIDER, model: MODEL, streamFn: async () => interrupted(stopReason) },
		}),
		() => {},
	);
}

for (const stopReason of ["error", "aborted"] as const) {
	test(`a call cut off by ${stopReason} is answered, so the history stays sendable`, async () => {
		const run = await runInterrupted(stopReason);
		const answer = run.messages.find((m) => m.role === "toolResult" && m.toolCallId === "call-1");

		assert.ok(answer, "the opened call was closed");
		assert.equal(answer.role === "toolResult" && answer.isError, true, "and closed as a failure, not a result");
	});

	test(`the ${stopReason} history is one Anthropic will accept`, async () => {
		/*
		 * The reason this matters at all: an unanswered `tool_use` is a 400 on every later request,
		 * so one dropped socket would take the whole conversation with it — including the 继续 after it.
		 */
		const run = await runInterrupted(stopReason);
		const wire = toAnthropicMessages(run.messages);

		let checked = 0;
		for (const [index, message] of wire.entries()) {
			for (const block of message.content) {
				if (block.type !== "tool_use") continue;
				checked += 1;
				const next = wire[index + 1];
				assert.ok(
					next?.role === "user" && next.content.some((b) => b.type === "tool_result" && b.tool_use_id === block.id),
					`tool_use ${String(block.id)} has no tool_result after it`,
				);
			}
		}
		// Without this the loop above passes by finding nothing, which is the one way it could be
		// green while the bug is present.
		assert.equal(checked, 1, "the half-sent call is still in the history — answered, not deleted");
	});
}

test("an interrupted call is failed rather than run, since its arguments never finished arriving", async () => {
	const run = await runInterrupted("error");
	const answer = run.messages.find((m) => m.role === "toolResult");
	const text = answer?.content.map((c) => (c.type === "text" ? c.text : "")).join("") ?? "";

	assert.match(text, /was not executed/);
	assert.match(text, /connection dropped/, "and it says why, so the model can decide to re-issue it");
});
