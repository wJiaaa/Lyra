/**
 * The loop obeying the Stop hook.
 *
 * The recoveries (`rejected-history`, `context-overflow`, `output-limit`, `live-model-switch`) are
 * covered end to end through `runAgent`. What was not covered anywhere is the Stop hook asking the
 * run to carry on — `hooks.test.ts` tests the hook, never the loop obeying it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { runAgent } from "../src/agent/loop.ts";
import type { AgentControlContext } from "../src/agent/run-config.ts";
import { emptyUsage, type AssistantMessage, type Message, type Tool } from "../src/types.ts";
import { runConfig } from "./run-config.ts";

const reply = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage => ({
	role: "assistant",
	content,
	api: "openai-responses",
	provider: "p",
	model: "m",
	stopReason,
	usage: emptyUsage(),
	timestamp: Date.now(),
});
const said = (text: string) => reply([{ type: "text", text }]);
const user: Message = { role: "user", content: [{ type: "text", text: "run the tests" }], timestamp: 1 };
const synthetic = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now(), synthetic: true });
const text = (message: Message | undefined) => JSON.stringify(message?.content ?? null);

async function run(replies: AssistantMessage[], control: Partial<AgentControlContext>, tools: Tool[] = []) {
	const sent: Message[][] = [];
	const result = await runAgent(
		runConfig({
			session: { messages: [user] },
			tools: { available: tools },
			model: {
				streamFn: async (context) => {
					sent.push([...context.messages]);
					const next = replies.shift();
					if (!next) throw new Error("no more replies");
					return next;
				},
			},
			control,
		}),
		async () => {},
	);
	return { result, sent };
}

test("a Stop hook that objects sends the run back with its message, and is asked again at the next stop", async () => {
	const asked: { responseText: string; toolCallCount: number }[] = [];
	const objection = synthetic("the tests have not been run");
	const { result, sent } = await run([said("done"), said("ran them, all green")], {
		onStop: async (info) => {
			asked.push(info);
			return asked.length === 1 ? objection : undefined;
		},
	});
	assert.equal(result.reason, "done");
	assert.equal(sent.length, 2, "the objection costs exactly one more request");
	assert.equal(text(sent[1].at(-1)), text(objection), "the model reads the objection next");
	assert.deepEqual(asked.map((info) => info.responseText), ["done", "ran them, all green"]);
	assert.ok(result.messages.includes(objection), "the objection is part of what the run produced");
});

test("the Stop hook is told how many tools this run called", async () => {
	const echo: Tool = { name: "echo", description: "e", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "ok" }] }) };
	let count = -1;
	await run(
		[reply([{ type: "toolCall", id: "c1", name: "echo", arguments: {} }], "toolUse"), said("done")],
		{
			onStop: async (info) => {
				count = info.toolCallCount;
				return undefined;
			},
		},
		[echo],
	);
	assert.equal(count, 1);
});

test("a Stop hook that throws does not keep the run going or turn a finished answer into an error", async () => {
	const { result, sent } = await run([said("done")], {
		onStop: async () => {
			throw new Error("hook crashed");
		},
	});
	assert.equal(result.reason, "done");
	assert.equal(sent.length, 1);
});

test("after a stop, the Stop hook is not asked: nobody is waiting to be told to carry on", async () => {
	const controller = new AbortController();
	let asked = 0;
	const sent: number[] = [];
	await runAgent(
		runConfig({
			session: { messages: [user] },
			model: {
				streamFn: async (context) => {
					sent.push(context.messages.length);
					controller.abort();
					return said("done");
				},
			},
			control: {
				signal: controller.signal,
				onStop: async () => {
					asked += 1;
					return synthetic("keep going");
				},
			},
		}),
		async () => {},
	);
	assert.equal(asked, 0);
	assert.equal(sent.length, 1);
});
