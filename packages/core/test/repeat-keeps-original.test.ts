/**
 * 同一份结果读到第三次：可以不再重贴，但模型眼前任何时刻都要至少有一份原文。
 *
 * 两处各自都对，合起来把原文剪没了：循环把第三次起的结果换成「不再重复贴一遍」，而
 * `stale-results` 从新往旧扫，把这句提示语当成最新的一份，更早的原文全被判成重复剪成「a later
 * call used the same arguments」——两句话互相指着对方，原文一份不剩。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { runAgent } from "../src/agent/loop.ts";
import { runConfig } from "./run-config.ts";
import { isRepeatNotice, originalInView, repeatNotice } from "../src/agent/repetition.ts";
import { dropStaleResults } from "../src/runtime/stale-results.ts";
import { emptyUsage, type AssistantMessage, type Message, type ModelConfig, type Tool, type ToolResultMessage } from "../src/types.ts";

const ORIGINAL = "export const answer = 42;\n".repeat(40);

const model: ModelConfig = { id: "m", modelId: "m", providerId: "p", name: "m", contextWindow: 100_000, maxOutputTokens: 100, supportsThinking: false, supportsImages: false, supportsTools: true };

function reads(id: string): AssistantMessage {
	return {
		role: "assistant", api: "openai-responses", provider: "p", model: "m", stopReason: "toolUse", usage: emptyUsage(), timestamp: 0,
		content: [{ type: "toolCall", id, name: "read", arguments: { path: "src/a.ts" }, argumentsText: "{}" }],
	};
}

function says(text: string): AssistantMessage {
	return { ...reads("x"), stopReason: "stop", content: [{ type: "text", text }] };
}

function shown(messages: Message[]): number {
	return messages.filter((message) => message.role === "toolResult" && message.content.some((part) => part.type === "text" && part.text === ORIGINAL)).length;
}

test("循环与 stale-results 合起来：读到第四次，每个请求里都还有一份原文", async () => {
	const tool: Tool = {
		name: "read", snippet: "read", description: "read", parameters: { type: "object", properties: {} },
		execute: async () => ({ content: [{ type: "text", text: ORIGINAL }] }),
	};
	const script = [reads("r1"), reads("r2"), reads("r3"), reads("r4"), says("看完了")];
	const requests: Message[][] = [];
	await runAgent(runConfig({
		session: { sessionId: "t", messages: [{ role: "user", content: [{ type: "text", text: "读 a.ts" }], timestamp: 0 }] },
		model: {
			model,
			provider: { id: "p", name: "p", api: "openai-responses", baseUrl: "http://localhost", apiKey: "", enabled: true, models: [model] },
			streamFn: async (context) => {
				// 循环复用同一个数组，要当场拍下这一次发出去的样子。
				requests.push([...context.messages]);
				return script.shift() ?? says("完");
			},
		},
		tools: { available: [tool], env: { cwd: "/test" }, requestApproval: async () => "allow" },
	}), async () => {});

	assert.equal(requests.length, 5);
	const last = requests.at(-1)!;
	assert.ok(last.some((message) => message.role === "toolResult" && isRepeatNotice(message)), "前提：第三次起确实换成了提示语");
	for (const [at, sent] of requests.entries()) {
		if (at === 0) continue;
		assert.ok(shown(sent) >= 1, `第 ${at + 1} 个请求里一份原文都没有了`);
	}
});

test("stale-results 不把提示语当成最新的一份：保留它之前最近那份原文", () => {
	const notice = (id: string): ToolResultMessage => ({ role: "toolResult", toolCallId: id, toolName: "read", isError: false, timestamp: 0, content: [{ type: "text", text: repeatNotice(3, "read") }] });
	const original = (id: string): ToolResultMessage => ({ role: "toolResult", toolCallId: id, toolName: "read", isError: false, timestamp: 0, content: [{ type: "text", text: ORIGINAL }] });
	const history: Message[] = [reads("r1"), original("r1"), reads("r2"), original("r2"), reads("r3"), notice("r3")];
	const after = dropStaleResults(history);
	assert.equal(shown(after), 1, "更早那份作为重复被剪，最近那份原文留着");
	assert.equal(after[3], history[3], "留下的是最近那份");
});

test("原文已经不在眼前时，不换成提示语——这一份就是原文", () => {
	const pruned: ToolResultMessage = { role: "toolResult", toolCallId: "r1", toolName: "read", isError: false, timestamp: 0, content: [{ type: "text", text: "[pruned — recall it]" }] };
	const fresh: ToolResultMessage = { ...pruned, toolCallId: "r2", content: [{ type: "text", text: ORIGINAL }] };
	const call = { name: "read", arguments: { path: "src/a.ts" } };
	assert.equal(originalInView([reads("r1"), pruned, reads("r2"), fresh], call, fresh), false);
	const kept: ToolResultMessage = { ...fresh, toolCallId: "r1" };
	assert.equal(originalInView([reads("r1"), kept, reads("r2"), fresh], call, fresh), true);
});

test("读到的正是含提示语模板的源码时，不会被错认成提示语", () => {
	const source: ToolResultMessage = {
		role: "toolResult", toolCallId: "r1", toolName: "read", isError: false, timestamp: 0,
		content: [{ type: "text", text: `${repeatNotice(3, "read")}\n还有别的内容` }],
	};
	assert.equal(isRepeatNotice(source), false);
});

test("压缩之后的重读从头数，不被当成第三次", async () => {
	/*
	 * 压缩把前两份原文收进了摘要，模型再读一次是在把它们拿回来。计数不清零的话，这一次会被算成
	 * 第三次：拿到一句「不再重复贴一遍」，外加一条说它在打转的自动提示。
	 */
	const tool: Tool = {
		name: "read", snippet: "read", description: "read", parameters: { type: "object", properties: {} },
		execute: async () => ({ content: [{ type: "text", text: ORIGINAL }] }),
	};
	const script = [reads("r1"), reads("r2"), reads("r3"), says("看完了")];
	let requests = 0;
	const sent: Message[][] = [];
	await runAgent(runConfig({
		session: {
			sessionId: "t",
			messages: [{ role: "user", content: [{ type: "text", text: "读 a.ts" }], timestamp: 0 }],
			// 第三个请求之前压缩一次：前面的读取全进了摘要。
			compact: async () => (requests === 2 ? { messages: [{ role: "user", content: [{ type: "text", text: "（摘要）读过 a.ts" }], timestamp: 0 }], summary: "读过 a.ts", kept: 0 } : null),
		},
		model: {
			model,
			provider: { id: "p", name: "p", api: "openai-responses", baseUrl: "http://localhost", apiKey: "", enabled: true, models: [model] },
			streamFn: async (context) => {
				requests += 1;
				sent.push([...context.messages]);
				return script.shift() ?? says("完");
			},
		},
		tools: { available: [tool], env: { cwd: "/test" }, requestApproval: async () => "allow" },
	}), async () => {});

	const last = sent.at(-1)!;
	assert.equal(shown(last), 1, "压缩后读到的那份就是原文");
	assert.ok(!last.some((message) => message.role === "toolResult" && isRepeatNotice(message)));
	assert.ok(!last.some((message) => message.role === "user" && message.content.some((part) => part.type === "text" && part.text.includes("自动提示"))), "也不说它在打转");
});
