/**
 * 名单上的记账：每个子代理花了多少。usage 按助手消息累加，用户消息不算。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { SubAgentRegistry } from "../src/runtime/sub-agents.ts";
import type { AssistantMessage, Message } from "../src/types.ts";
import { emptyUsage } from "../src/types.ts";

/** 一条带账单的回复：provider 在真实运行里就是这样把 usage 填好再交出来的。 */
function priced(text: string, input: number, output: number, cost: number): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-responses",
		provider: "fake",
		model: "model",
		usage: { ...emptyUsage(), input, output, total: input + output, cost: { ...emptyUsage().cost, total: cost } },
		stopReason: "stop",
		timestamp: Date.now(),
		content: [{ type: "text", text }],
	};
}

test("注册表：花了多少在摘要里", () => {
	const registry = new SubAgentRegistry();
	registry.start({ id: "a", agent: "explore", description: "找", abort: () => {} });

	const [a] = registry.list();
	assert.deepEqual(a.usage, emptyUsage(), "还没说话，账单是零");

	registry.record("a", priced("一", 100, 10, 0.5));
	registry.record("a", priced("二", 200, 20, 0.25));
	const user: Message = { role: "user", content: [{ type: "text", text: "插话" }], timestamp: 0 };
	registry.record("a", user);

	const after = registry.list()[0].usage;
	assert.equal(after.input, 300, "每条助手消息是一次请求，输入按次累加");
	assert.equal(after.output, 30);
	assert.equal(after.total, 330);
	assert.equal(after.cost.total, 0.75);
	assert.equal(registry.detail("a")?.messages.length, 3, "用户消息进了记录，但不进账单");
});
