/**
 * 上下文超出模型窗口：认出来，强制压缩一次，再发一次。
 *
 * 从前超长报错落在 `check-request` 里，循环只会剪过大的工具输出——没有可剪的，这一轮失败，而
 * 下一轮带着同一段历史再发，还是超长：会话卡死。这里守三件事：
 *
 *   1. 各家服务商的超长原话都被认成 `code: "context-overflow"`，限流和别的 400 不会；
 *   2. 认出来之后压缩一次再发，每轮最多一次，压不动或压完还超长就如实报错；
 *   3. 被拒的那条回复不进日志——压缩边界按「最后 N 条」从日志末尾数，多一条就数偏。
 *
 * 循环那几条走真的 `streamAssistant`，只把 `fetch` 换掉：服务商回什么正文，分类器就看到什么。
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent, type AgentRunConfig, type StreamRequest } from "../src/agent/loop.ts";
import type { CompactHistory } from "../src/agent/compact-step.ts";
import type { AgentEvent } from "../src/agent/events.ts";
import { classifyFailure, isContextOverflow } from "../src/ai/failure.ts";
import type { streamAssistant } from "../src/ai/index.ts";
import { compactWith, useCompaction } from "../src/runtime/compaction.ts";
import { PRUNE_THRESHOLD_CHARS } from "../src/runtime/prune.ts";
import { SessionLog } from "../src/runtime/session-log.ts";
import { modelHistory } from "../src/runtime/session-turn.ts";
import { runSubAgent } from "../src/runtime/sub-agent.ts";
import { SubAgentRegistry } from "../src/runtime/sub-agents.ts";
import { SessionStore } from "../src/session/store.ts";
import type { AgentDefinition } from "../src/agents-builtin.ts";
import type { Settings } from "../src/config/settings.ts";
import { emptyUsage, type AssistantMessage, type Message, type ModelConfig, type ProviderConfig } from "../src/types.ts";

// ---------------------------------------------------------------------------
// 1. 认出来
// ---------------------------------------------------------------------------

/** 各家的超长原话。新增一种说法时在这里加一行，再到 `failure.ts` 的 `CONTEXT_OVERFLOW` 里加正则。 */
const OVERFLOW_BODIES: [source: string, status: number, body: string][] = [
	["OpenAI Chat", 400, JSON.stringify({ error: { message: "This model's maximum context length is 128000 tokens. However, your messages resulted in 130512 tokens.", type: "invalid_request_error", code: "context_length_exceeded" } })],
	["OpenAI 只给 code", 400, JSON.stringify({ error: { message: "Invalid request.", code: "context_length_exceeded" } })],
	["OpenAI Responses", 400, JSON.stringify({ error: { message: "Your input exceeds the context window of this model. Please adjust your input and try again." } })],
	["Anthropic", 400, JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 213462 tokens > 200000 maximum" } })],
	["Anthropic 兼容端点：input + max_tokens", 400, JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "input length and `max_tokens` exceed context limit: 188000 + 21333 > 200000, decrease input length or `max_tokens` and try again" } })],
	["Anthropic 413", 413, JSON.stringify({ type: "error", error: { type: "request_too_large", message: "Request exceeds the maximum size" } })],
	["413 无正文", 413, ""],
	["DeepSeek", 400, JSON.stringify({ error: { message: "This model's maximum context length is 65536 tokens. However, you requested 70123 tokens (66027 in the messages, 4096 in the completion). Please reduce the length of the messages or completion.", type: "invalid_request_error" } })],
	["Kimi / Moonshot", 400, JSON.stringify({ error: { message: "Invalid request: Your request exceeded model token limit: 262144", type: "invalid_request_error" } })],
	["Gemini", 400, JSON.stringify({ error: { message: "The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)." } })],
	["通义 DashScope", 400, JSON.stringify({ error: { code: "invalid_parameter_error", message: "Range of input length should be [1, 129024]" } })],
	["z.ai", 400, JSON.stringify({ error: { code: "1261", message: "Prompt too long" } })],
	["MiniMax", 400, JSON.stringify({ base_resp: { status_code: 2013, status_msg: "invalid params, context window exceeds limit" } })],
	["中转中文原话", 400, JSON.stringify({ error: { message: "请求失败：上下文长度超过模型限制" } })],
	["中转写成 500", 500, JSON.stringify({ error: { message: "upstream error: prompt is too long: 250000 tokens > 200000 maximum" } })],
];

for (const [source, status, body] of OVERFLOW_BODIES) {
	test(`上下文超长被认出来：${source}`, () => {
		const failure = classifyFailure({ from: "status", status, body });
		assert.equal(failure.kind, "fatal", "重发同一个请求不会变");
		assert.equal(failure.hint, "check-request", "界面上的动作不变");
		assert.ok(isContextOverflow(failure), `应当是超长：${failure.summary}`);
	});
}

test("写在流里的超长报错同样认得出来", () => {
	const failure = classifyFailure({ from: "stream", message: "prompt is too long: 213462 tokens > 200000 maximum" });
	assert.equal(failure.kind, "fatal");
	assert.ok(isContextOverflow(failure));
});

test("限流、别的请求体错误都不是超长", () => {
	const cases: [string, ReturnType<typeof classifyFailure>][] = [
		["Bedrock 限流原话", classifyFailure({ from: "stream", message: "ThrottlingException: Too many tokens, please wait before trying again." })],
		["429 里的 too many tokens", classifyFailure({ from: "status", status: 429, body: "Too many tokens" })],
		["明说是限流", classifyFailure({ from: "status", status: 400, body: JSON.stringify({ error: { message: "Rate limit reached: too many tokens per min" } }) })],
		["格式错误的 400", classifyFailure({ from: "status", status: 400, body: JSON.stringify({ error: { message: "Unknown name \"safetySettings\" at 'request.contents[42]'" } }) })],
		["max_tokens 参数太大", classifyFailure({ from: "status", status: 400, body: JSON.stringify({ error: { message: "max_tokens: 100000 > 64000, which is the maximum allowed number of output tokens" } }) })],
		["422", classifyFailure({ from: "status", status: 422, body: "invalid schema" })],
	];
	for (const [what, failure] of cases) assert.equal(isContextOverflow(failure), false, what);
});

// ---------------------------------------------------------------------------
// 2. 循环：压缩一次，再发一次
// ---------------------------------------------------------------------------

const MODEL: ModelConfig = { id: "fake/model", providerId: "fake", modelId: "gpt-test", name: "Fake", contextWindow: 200_000, maxOutputTokens: 4096, supportsThinking: false, supportsImages: false, supportsTools: true };
const PROVIDER: ProviderConfig = { id: "fake", name: "Fake", baseUrl: "https://relay.test", api: "openai-responses", apiKey: "sk-test", enabled: true, models: [MODEL] };

const encoder = new TextEncoder();
const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
/** 一次正常的应答。 */
const ok = (text = "好了") =>
	new Response(
		new ReadableStream({
			start(controller) {
				for (const payload of [
					{ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1" } },
					{ type: "response.output_text.delta", output_index: 0, delta: text },
					{ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_1", content: [{ text }] } },
					{ type: "response.completed", response: { id: "resp_1", usage: { input_tokens: 1000, output_tokens: 20 } } },
				]) controller.enqueue(encoder.encode(frame(payload)));
				controller.close();
			},
		}),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
const refuse = (status: number, body: string) => () => new Response(body, { status });

/** 每次 fetch 依次取一个应答，记下请求体里的对话。 */
function serve(replies: (() => Response)[]) {
	const bodies: Record<string, unknown>[] = [];
	const original = globalThis.fetch;
	globalThis.fetch = (async (_url: string, init: RequestInit) => {
		bodies.push(JSON.parse(String(init.body)));
		return replies[Math.min(bodies.length - 1, replies.length - 1)]();
	}) as typeof globalThis.fetch;
	restore = () => (globalThis.fetch = original);
	return bodies;
}
let restore = () => {};
afterEach(() => {
	restore();
	useCompaction(null);
});

const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const reply = (text: string): AssistantMessage => ({ role: "assistant", content: [{ type: "text", text }], api: PROVIDER.api, provider: PROVIDER.id, model: MODEL.modelId, usage: emptyUsage(), stopReason: "stop", timestamp: 2 });
const history = (): Message[] => Array.from({ length: 6 }, (_, i) => [user(`第 ${i} 个问题 ${"x".repeat(200)}`), reply(`第 ${i} 个回答`)]).flat().concat(user("接着做"));

/** 一个假的压缩：只在强制时动手，记下被叫了几次，返回「摘要 + 最后两条」。 */
function fakeCompact(outcome: "ok" | "none" = "ok") {
	const calls: { force?: boolean; length: number }[] = [];
	const compact: CompactHistory = async (messages, _model, _observer, options) => {
		// 每轮开头那次按 80% 线判断，这里的对话远不到线，照实返回「不需要」。
		if (!options?.force) return null;
		calls.push({ force: options.force, length: messages.length });
		if (outcome === "none") return null;
		const kept = messages.slice(-2);
		return { messages: [user("（摘要）前面聊过的都在这里"), ...kept], summary: "前面聊过的都在这里", kept: kept.length };
	};
	return { compact, calls };
}

async function run(config: Partial<AgentRunConfig>) {
	const events: AgentEvent[] = [];
	const result = await runAgent(
		{ sessionId: "s", cwd: "/tmp", provider: PROVIDER, model: MODEL, systemPrompt: "", tools: [], messages: history(), retryAttempts: 1, ...config },
		async (event) => { events.push(event); },
	);
	return { result, events };
}

const committedErrors = (events: AgentEvent[]) => events.filter((event) => event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "error");

for (const [source, status, body] of OVERFLOW_BODIES.filter(([source]) => ["OpenAI Chat", "Anthropic", "Kimi / Moonshot", "中转中文原话", "413 无正文"].includes(source))) {
	test(`超长时强制压缩一次并重发：${source}`, async () => {
		const bodies = serve([refuse(status, body), () => ok()]);
		const { compact, calls } = fakeCompact();
		const { result, events } = await run({ compact });

		assert.equal(result.reason, "done", "重发成功，这一轮接着走");
		assert.equal(bodies.length, 2, "一次被拒，一次重发");
		assert.deepEqual(calls, [{ force: true, length: 13 }], "压缩只叫了一次，而且是强制的");
		assert.equal((bodies[1].input as unknown[]).length < (bodies[0].input as unknown[]).length, true, "重发的是压缩后的历史");
		assert.ok(events.some((event) => event.type === "notice" && /超出了模型的上限/.test(event.message)), "界面知道为什么多等了一次");
		assert.ok(events.some((event) => event.type === "compacted"), "压缩边界照常发出");
		assert.equal(committedErrors(events).length, 0, "被拒的那条没有提交");
		assert.equal(result.messages.at(-1)?.role, "assistant");
	});
}

test("压缩后仍然超长：只重试一次，照原错误收场", async () => {
	const overflow = OVERFLOW_BODIES[3];
	const bodies = serve([refuse(overflow[1], overflow[2])]);
	const { compact, calls } = fakeCompact();
	const { result, events } = await run({ compact });

	assert.equal(bodies.length, 2, "压缩后重发一次，不再往下试");
	assert.equal(calls.length, 1);
	assert.equal(result.reason, "error");
	assert.match(result.error ?? "", /上下文超出模型上限/);
	assert.equal(committedErrors(events).length, 1, "最后那条错误如实提交一次");
});

test("没压小（压缩返回 null）：不重发，如实报错", async () => {
	const overflow = OVERFLOW_BODIES[0];
	const bodies = serve([refuse(overflow[1], overflow[2]), () => ok()]);
	const { compact, calls } = fakeCompact("none");
	const { result, events } = await run({ compact });

	assert.equal(bodies.length, 1);
	assert.equal(calls.length, 1);
	assert.equal(result.reason, "error");
	assert.equal(committedErrors(events).length, 1);
});

test("不是超长的 400 不触发压缩", async () => {
	const bodies = serve([refuse(400, JSON.stringify({ error: { message: "Unknown name \"safetySettings\" at 'request.contents[42]'" } })), () => ok()]);
	const { compact, calls } = fakeCompact();
	const { result } = await run({ compact });

	assert.equal(calls.length, 0);
	assert.equal(bodies.length, 1, "没东西可剪，也不压缩");
	assert.equal(result.reason, "error");
});

test("有过大的工具输出：先剪、剪完还超长再压缩，一轮之内各一次", async () => {
	const overflow = OVERFLOW_BODIES[0];
	const bodies = serve([refuse(overflow[1], overflow[2]), refuse(overflow[1], overflow[2]), () => ok()]);
	const { compact, calls } = fakeCompact();
	const messages: Message[] = [
		user("看看发布列表"),
		{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {}, argumentsText: "{}" }], api: PROVIDER.api, provider: PROVIDER.id, model: MODEL.modelId, usage: emptyUsage(), stopReason: "toolUse", timestamp: 2 },
		{ role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "x".repeat(PRUNE_THRESHOLD_CHARS * 3) }], isError: false, timestamp: 3 },
	];
	const { result, events } = await run({ compact, messages });

	assert.equal(bodies.length, 3, "原请求、剪完重发、压缩后重发");
	assert.equal(calls.length, 1);
	assert.equal(result.reason, "done");
	assert.equal(committedErrors(events).length, 0);
});

test("没有压缩通道（旁路调用）时和从前一样直接报错", async () => {
	const overflow = OVERFLOW_BODIES[0];
	const bodies = serve([refuse(overflow[1], overflow[2]), () => ok()]);
	const { result } = await run({});
	assert.equal(bodies.length, 1);
	assert.equal(result.reason, "error");
});

test("走真的压缩通道：用量远低于 80% 线也照样压", async () => {
	const overflow = OVERFLOW_BODIES[3];
	const bodies = serve([refuse(overflow[1], overflow[2]), () => ok()]);
	const summaries: number[] = [];
	const summarizer: typeof streamAssistant = async function* () {
		summaries.push(1);
		yield { type: "start", partial: reply("") };
		return reply("之前做过的事和剩下的活");
	};
	const long = Array.from({ length: 12 }, (_, i) => [user(`请求 ${i} ${"x".repeat(2000)}`), reply(`回答 ${i} ${"y".repeat(2000)}`)]).flat();
	const { result, events } = await run({
		messages: long,
		compact: (messages, model, observer, options) => compactWith({ messages, model, provider: PROVIDER, streamFn: summarizer, observer, force: options?.force }),
	});

	assert.equal(summaries.length, 1, "摘要请求发了一次");
	assert.equal(bodies.length, 2);
	assert.equal(result.reason, "done");
	const boundary = events.find((event) => event.type === "compacted");
	assert.ok(boundary && boundary.type === "compacted" && boundary.kept !== undefined, "带边界，会话据此落盘");
});

test("被拒的那条不进日志：压缩边界落在跟发出去的同一处", async () => {
	/*
	 * 从前被拒的回复先提交再重发，日志末尾就多一条循环眼里没有的错误。边界记的是「最后 N 条」，
	 * 从日志末尾数就偏一条：下一轮重建的历史和刚发出去的对不上，缓存前缀断开。
	 */
	const root = await mkdtemp(join(tmpdir(), "plume-overflow-"));
	try {
		const store = new SessionStore(root);
		const log = new SessionLog(store, () => {}, await store.create(root, MODEL.id));
		for (const message of history()) await log.commit(message);

		const overflow = OVERFLOW_BODIES[0];
		serve([refuse(overflow[1], overflow[2]), () => ok("压缩后接着做")]);
		const sent: Message[][] = [];
		const { compact } = fakeCompact();
		await runAgent(
			{ sessionId: "s", cwd: "/tmp", provider: PROVIDER, model: MODEL, systemPrompt: "", tools: [], messages: [...log.messages], retryAttempts: 1, compact, onContext: (context) => sent.push([...context.messages]) },
			async (event) => {
				if (event.type === "message_end") await log.commit(event.message);
				await log.emit(event);
			},
		);

		assert.equal(log.messages.some((message) => message.role === "assistant" && message.stopReason === "error"), false, "日志里没有被拒的那条");
		const rebuilt = modelHistory(log, PROVIDER, MODEL);
		const retried = sent.at(-1) ?? [];
		// 摘要头每次重建，比内容；其后的保留尾部要逐条就是刚才发出去的那几条，再接上这次的回复。
		assert.deepEqual(rebuilt.slice(-3, -1), retried.slice(-2), "保留的尾部没有数偏");
		assert.equal(rebuilt.at(-1)?.role, "assistant");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// 3. 子代理：同一条路，自己的 cacheKey
// ---------------------------------------------------------------------------

test("子代理同样压缩后重发，每个请求带着它自己的、续跑不变的 cacheKey", async () => {
	const forced: boolean[] = [];
	useCompaction({
		compact: async (request) => {
			if (!request.force) return null;
			forced.push(true);
			const kept = request.messages.slice(-1);
			return { messages: [user("（摘要）"), ...kept], summary: "摘要", kept: kept.length };
		},
	});
	const keys: (string | undefined)[] = [];
	let calls = 0;
	const events: AgentEvent[] = [];
	const general: AgentDefinition = { name: "general", description: "通用", systemPrompt: "do the work", tools: "*", source: "builtin", maxTurns: 4 };
	const options = {
		sessionId: "parent",
		cwd: "/tmp",
		settings: { thinking: "off" } as unknown as Settings,
		tools: [],
		skills: [],
		agents: [general],
		registry: new SubAgentRegistry(),
		requestApproval: async () => "once" as const,
		emit: async (event: AgentEvent) => { events.push(event); },
		streamFn: async (_context: unknown, config: StreamRequest) => {
			keys.push(config.cacheKey);
			calls += 1;
			if (calls === 1) {
				const failure = classifyFailure({ from: "status", status: 400, body: JSON.stringify({ error: { code: "context_length_exceeded", message: "too long" } }) });
				return { ...reply(""), content: [], stopReason: "error" as const, errorMessage: failure.summary, errorRetryable: false, failure };
			}
			return reply("查完了");
		},
	};
	const answer = await runSubAgent(options, { description: "查", prompt: "查一下" }, PROVIDER, MODEL);

	assert.equal(answer.text, "查完了");
	assert.deepEqual(forced, [true], "强制压缩了一次");
	assert.equal(calls, 2);
	assert.ok(keys[0] && keys[0] !== "parent" && keys[0].startsWith("parent"), `和父会话分开：${keys[0]}`);
	assert.equal(new Set(keys).size, 1, "同一个子代理的请求共用一个 key");
	assert.ok(events.some((event) => event.type === "subagent_event" && event.event.type === "notice"), "说明进了它自己的面板");

	// 续跑接着上一次的 `view` 发，前缀相同，key 也要是同一个才落到那份缓存上。
	await runSubAgent(options, { description: "查", prompt: "再看一眼", resume: answer.id }, PROVIDER, MODEL);
	assert.equal(calls, 3);
	assert.equal(keys.at(-1), keys[0], "续跑沿用同一个 key");
	const other = await runSubAgent(options, { description: "另一件", prompt: "别的" }, PROVIDER, MODEL);
	assert.notEqual(other.id, answer.id);
	assert.notEqual(keys.at(-1), keys[0], "另派的一个不共用");
});
