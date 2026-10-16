/**
 * 收尾规则的两张表（`agent/turn-checks.ts`）：怎么问，以及表里写明了理由的顺序。
 *
 * 怎么问用假规则测，不跑整个循环：正文那张第一条有意见的规则说了算；工具那张 `say` 说完接着问，
 * 按轮计数的规则（进度、重复）要看到每一轮。顺序用真表测：Stop 钩子排在清单收尾前面——钩子看到的是
 * 真正的回答；被输出上限截断的回复接着写，而不是当成空回复催。每条规则各自的行为由 `stop-hook-loop`、
 * `open-plan-check`、`output-limit`、`nudge`、`repetition` 这些经过 `runAgent` 的测试守着。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { PlanWatch } from "../src/agent/plan-watch.ts";
import { RepetitionWatch } from "../src/agent/repetition.ts";
import { askAfterProse, askAfterTools, turnChecks } from "../src/agent/turn-checks.ts";
import { runConfig } from "./run-config.ts";
import { TODOS_KEY, todoTool, type TodoItem } from "../src/tools/todo.ts";
import type { AssistantMessage, Message } from "../src/types.ts";
import { emptyUsage } from "../src/types.ts";

function reply(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return { role: "assistant", api: "openai-responses", provider: "p", model: "m", usage: emptyUsage(), stopReason, timestamp: Date.now(), content };
}

const note = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: 0, synthetic: true });
const textOf = (message: Message) => (message.content as { type: string; text?: string }[]).map((part) => part.text ?? "").join("");

/** 一张假表：每条规则记下自己被问过，再交回事先给定的结论。 */
function table(verdicts: ({ say: Message } | { end: { reason: "done" | "stalled" } } | undefined)[]) {
	const asked: number[] = [];
	const checks = verdicts.map((verdict, index) => () => {
		asked.push(index);
		return verdict;
	});
	return { asked, checks };
}

async function ask(side: "prose" | "tools", verdicts: Parameters<typeof table>[0]) {
	const { asked, checks } = table(verdicts);
	const said: string[] = [];
	const inject = async (message: Message) => {
		said.push(textOf(message));
	};
	const ending = side === "prose"
		? await askAfterProse({ afterProse: checks, afterTools: [] }, {} as never, inject)
		: await askAfterTools({ afterProse: [], afterTools: checks }, {} as never, inject);
	return { ending, asked, said };
}

test("after prose, the first rule with something to say decides and the rest are not asked", async () => {
	const { ending, asked, said } = await ask("prose", [undefined, { say: note("a") }, { say: note("b") }]);
	assert.equal(ending, undefined, "saying something means another round");
	assert.deepEqual(said, ["a"]);
	assert.deepEqual(asked, [0, 1]);
});

test("after prose, the run ends as done when no rule has anything to say", async () => {
	const { ending } = await ask("prose", [undefined, undefined]);
	assert.deepEqual(ending, { reason: "done" });
});

test("after tools, every rule is asked and everything said goes in, in table order", async () => {
	const { ending, asked, said } = await ask("tools", [{ say: note("a") }, undefined, { say: note("b") }]);
	assert.equal(ending, undefined);
	assert.deepEqual(said, ["a", "b"]);
	assert.deepEqual(asked, [0, 1, 2], "rules that count turns must see this one even after another spoke");
});

test("after tools, an ending stops the table; what was said before it stays said", async () => {
	const { ending, asked, said } = await ask("tools", [{ say: note("a") }, { end: { reason: "stalled" } }, { say: note("b") }]);
	assert.deepEqual(ending, { reason: "stalled" });
	assert.deepEqual(said, ["a"]);
	assert.deepEqual(asked, [0, 1]);
});

/** 用真表问一条正文回复，清单里还挂着一项「正在做」。返回说出口的话，或者收场的理由。 */
async function askRealTable(control: Parameters<typeof turnChecks>[0], assistant: AssistantMessage) {
	const state = new Map<string, unknown>();
	const open: TodoItem[] = [{ content: "总结", status: "in_progress", activeForm: "总结中" }];
	state.set(TODOS_KEY, open);
	const plan = new PlanWatch(state, [todoTool]);
	// 这次运行干过活，清单收尾时才会被问到。
	plan.beforeTools([{ type: "toolCall", id: "r1", name: "read", arguments: {}, argumentsText: "{}" }]);
	const checks = turnChecks(control, async () => {}, plan, new RepetitionWatch());
	const said: Message[] = [];
	const ending = await askAfterProse(checks, { assistant, turnsLeft: true, produced: [] }, async (message) => {
		said.push(message);
	});
	return { ending, said };
}

test("the Stop hook is asked before the open-plan question, so it sees the real answer", async () => {
	const resume: Message = { role: "user", content: [{ type: "text", text: "钩子：还没跑测试" }], timestamp: Date.now() };
	const { control } = runConfig({ control: { onStop: async () => resume } });
	const { ending, said } = await askRealTable(control, reply([{ type: "text", text: "做完了" }], "stop"));
	assert.equal(ending, undefined);
	assert.deepEqual(said, [resume]);
});

test("a reply cut off by the output limit is continued, not nudged as an empty one", async () => {
	const { control } = runConfig();
	const { said } = await askRealTable(control, reply([], "length"));
	assert.equal(said.length, 1);
	assert.match(textOf(said[0]), /输出长度上限/);
});

/*
 * 桌面端靠 `synthetic` 分辨「人开了新一轮」和「运行时续跑」：漏标的那句会被当成人开口，一轮切成两段，
 * 页脚提前贴在前一段正文底下（会话 d372d301）。所以真表在正文之后说的每一句都得带着它。
 */
test("every sentence the real table says after prose is marked synthetic", async () => {
	const { control } = runConfig();
	const cases = [reply([{ type: "text", text: "做完了" }], "stop"), reply([], "length"), reply([], "stop")];
	for (const assistant of cases) {
		const { said } = await askRealTable(control, assistant);
		assert.equal(said.length, 1, assistant.stopReason);
		assert.equal(said[0].role === "user" && said[0].synthetic, true, textOf(said[0]));
	}
});
