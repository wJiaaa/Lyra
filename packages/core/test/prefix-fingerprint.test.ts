/**
 * 缓存未命中的归因证据：请求前缀从哪里开始和上一次不同。
 *
 * 只看 usage 分不清「本地改了前缀」和「服务商没读到」——这两种要做的事完全不同。
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { runAgent } from "../src/agent/loop.ts";
import { runConfig } from "./run-config.ts";
import { comparePrefix, payloadSegments } from "../src/ai/prefix-fingerprint.ts";
import { diagnoseCache } from "../src/runtime/cache-diagnostics.ts";
import { emptyUsage, type AssistantMessage, type Message, type ModelConfig, type ProviderConfig } from "../src/types.ts";

test("只追加消息时没有变化；改了中间一条，变化落在那一条上", () => {
	const first = payloadSegments({ system: "s", tools: [{ name: "t" }], messages: [{ role: "user", content: "a" }] });
	const appended = payloadSegments({ system: "s", tools: [{ name: "t" }], messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }] });
	assert.deepEqual(comparePrefix(first, appended), { segments: 5 });

	const edited = payloadSegments({ system: "s", tools: [{ name: "t" }], messages: [{ role: "user", content: "a!" }, { role: "assistant", content: "b" }] });
	assert.deepEqual(comparePrefix(appended, edited).change, { segment: "messages[0]", before: 29, after: 30 });
	assert.equal(comparePrefix(appended, payloadSegments({ system: "s2", tools: [{ name: "t" }], messages: [] })).change?.segment, "system");
});

test("Chat Completions 开头那条 system 消息记成 system，改了提示词不会被当成改写历史", () => {
	const body = (prompt: string) => ({ tools: [{ name: "t" }], messages: [{ role: "system", content: prompt }, { role: "user", content: "a" }] });
	assert.deepEqual(payloadSegments(body("s")).map((segment) => segment.name), ["tools", "system", "params", "messages[1]"]);
	assert.equal(comparePrefix(payloadSegments(body("s")), payloadSegments(body("s2"))).change?.segment, "system");
});

test("挪动的 cache_control 断点不算前缀变化", () => {
	const before = payloadSegments({ messages: [{ role: "user", content: [{ type: "text", text: "a", cache_control: { type: "ephemeral" } }] }] });
	const after = payloadSegments({ messages: [{ role: "user", content: [{ type: "text", text: "a" }] }, { role: "user", content: [{ type: "text", text: "b", cache_control: { type: "ephemeral" } }] }] });
	assert.equal(comparePrefix(before, after).change, undefined);
});

test("工具 schema 和调用参数里同名的 cache_control 是真数据，变了照样算", () => {
	const tools = (value: string) => [{ name: "t", input_schema: { type: "object", properties: { cache_control: { const: value } } }, cache_control: { type: "ephemeral" } }];
	assert.equal(comparePrefix(payloadSegments({ tools: tools("no-store") }), payloadSegments({ tools: tools("public") })).change?.segment, "tools");
	const call = (value: string) => ({ messages: [{ role: "assistant", content: [{ type: "tool_use", id: "c", name: "t", input: { cache_control: value } }] }] });
	assert.equal(comparePrefix(payloadSegments(call("no-store")), payloadSegments(call("public"))).change?.segment, "messages[0]");
	const system = (breakpoint: boolean) => ({ system: [{ type: "text", text: "s", ...(breakpoint ? { cache_control: { type: "ephemeral" } } : {}) }] });
	assert.equal(comparePrefix(payloadSegments(system(true)), payloadSegments(system(false))).change, undefined, "system 块上的断点不算");
});

test("thinking 档位这类请求参数变了算前缀变化；逐次重算的输出上限不算", () => {
	const body = (budget: number, maxTokens: number) => ({ model: "m", max_tokens: maxTokens, stream: true, thinking: { type: "enabled", budget_tokens: budget }, system: "s", messages: [{ role: "user", content: "a" }] });
	assert.equal(comparePrefix(payloadSegments(body(4096, 8000)), payloadSegments(body(24_576, 8000))).change?.segment, "params");
	assert.equal(comparePrefix(payloadSegments(body(4096, 8000)), payloadSegments(body(4096, 6000))).change, undefined);
	const reply = (cacheRead: number, prefix?: AssistantMessage["prefix"]): AssistantMessage => ({
		role: "assistant", content: [], api: "anthropic-messages", provider: "p", model: "m", stopReason: "stop", timestamp: 1,
		usage: { ...emptyUsage(), input: 5000 - cacheRead, cacheRead }, ...(prefix ? { prefix } : {}),
	});
	const [, second] = diagnoseCache([reply(4000), reply(0, { segments: 4, change: { segment: "params", before: 60, after: 61 } })]);
	assert.equal(second.cause, "unknown", "证据不够分清，不归到服务商头上");
});

test("某一段整个出现或消失（关掉 thinking、工具全断开），变化记在那一段上，不错位到后面", () => {
	const on = { system: "s", thinking: { type: "enabled", budget_tokens: 4096 }, messages: [{ role: "user", content: "a" }] };
	const off = { system: "s", messages: [{ role: "user", content: "a" }] };
	assert.equal(comparePrefix(payloadSegments(on), payloadSegments(off)).change?.segment, "params");
	assert.equal(comparePrefix(payloadSegments(off), payloadSegments(on)).change?.segment, "params");
	const withTools = { tools: [{ name: "t" }], system: "s", messages: [{ role: "user", content: "a" }] };
	assert.equal(comparePrefix(payloadSegments(withTools), payloadSegments(off)).change?.segment, "tools");
	const chat = (system: boolean) => ({ messages: [...(system ? [{ role: "system", content: "s" }] : []), { role: "user", content: "a" }] });
	assert.equal(comparePrefix(payloadSegments(chat(true)), payloadSegments(chat(false))).change?.segment, "system");
});

test("诊断把回复上记下的前缀变化带出来", () => {
	const reply = (cacheRead: number, prefix?: AssistantMessage["prefix"]): AssistantMessage => ({
		role: "assistant", content: [], api: "openai-chat-completions", provider: "p", model: "m", stopReason: "stop", timestamp: 1,
		usage: { ...emptyUsage(), input: 5000 - cacheRead, cacheRead }, ...(prefix ? { prefix } : {}),
	});
	const change = { segment: "messages[3]", before: 900, after: 120 };
	const [, second] = diagnoseCache([reply(4000), reply(0, { segments: 6, change })]);
	assert.equal(second.cause, "rewrite");
	assert.deepEqual(second.prefix, { segments: 6, change });
});

// ---------------------------------------------------------------------------
// 接线：真适配器发出去的请求体
// ---------------------------------------------------------------------------

let server: Server;
let base = "";
/** 下一个请求答 400：没有用量的失败请求。 */
let failNext = false;
before(async () => {
	server = createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			if (failNext) {
				failNext = false;
				res.writeHead(400, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { message: "bad request" } }));
				return;
			}
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end(
				`data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"好"},"finish_reason":"stop"}]}\n\n` +
					`data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":1}}\n\ndata: [DONE]\n\n`,
			);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

test("同一会话的下一次请求，回复上写着前缀是否变了、变在哪", async () => {
	const model: ModelConfig = { id: "t/m", providerId: "t", modelId: "m", name: "M", contextWindow: 100_000, maxOutputTokens: 256, supportsThinking: false, supportsImages: false, supportsTools: true };
	const provider: ProviderConfig = { id: "t", name: "T", baseUrl: base, api: "openai-chat-completions", apiKey: "x", enabled: true, models: [model] };
	const state = new Map<string, unknown>();
	const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
	const turn = async (messages: Message[], systemPrompt = "sys") => {
		const result = await runAgent(runConfig({ session: { systemPrompt, state, messages }, model: { provider, model, retryAttempts: 1 } }), async () => {});
		return result.messages.find((m): m is AssistantMessage => m.role === "assistant")!;
	};

	const first = await turn([user("一")]);
	assert.equal(first.prefix, undefined, "第一次没有可比的");
	const second = await turn([user("一"), first, user("二")]);
	assert.ok(second.prefix && second.prefix.segments > 0, "量过了");
	assert.equal(second.prefix.change, undefined, "只是往后接：上一次原样是这一次的前缀");
	const third = await turn([user("改过的一"), first, user("二"), second, user("三")]);
	assert.match(third.prefix?.change?.segment ?? "", /^messages\[\d\]$/, "改了开头那条，变化落在消息上");

	// 失败的那次诊断跳过，比的是前后两次成功的；基准也不能从失败那次推进，否则会报「前缀没变」。
	failNext = true;
	const failed = await turn([user("一")], "sys-changed");
	assert.equal(failed.stopReason, "error");
	const after = await turn([user("一")], "sys-changed");
	assert.equal(after.prefix?.change?.segment, "system", "和上一次成功的比，系统提示词那条变了");
});
