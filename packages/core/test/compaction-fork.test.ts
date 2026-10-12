/**
 * 摘要请求从主请求分叉：请求体逐字节比对，以及每一种退回独立请求的情形。
 *
 * 第一条走真实的 Anthropic 编码（`globalThis.fetch` 换成桩），比的是线上真正发出去的 JSON——缓存
 * 只认这个，类型和中间对象一致不算数。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { lineageFrom } from "../src/agent/lineage.ts";
import { runAgent } from "../src/agent/loop.ts";
import { streamTurn } from "../src/agent/stream-turn.ts";
import { streamAssistant } from "../src/ai/index.ts";
import { compactIfNeeded, compactWith } from "../src/runtime/compaction.ts";
import { FORK_HOT_MS } from "../src/runtime/compaction-fork.ts";
import { SUMMARY_SYSTEM } from "../src/runtime/compaction-prompts.ts";
import { emptyUsage, type AssistantMessage, type Message, type ModelConfig, type ProviderConfig } from "../src/types.ts";
import { runConfig } from "./run-config.ts";

const MODEL: ModelConfig = {
	id: "anthropic/opus",
	providerId: "anthropic",
	modelId: "claude-opus",
	name: "Opus",
	contextWindow: 200_000,
	maxOutputTokens: 32_000,
	supportsThinking: true,
	supportsImages: false,
	supportsTools: true,
};
const PROVIDER: ProviderConfig = { id: "anthropic", name: "Anthropic", baseUrl: "https://relay.example.com", api: "anthropic-messages", apiKey: "k", enabled: true, models: [MODEL] };
const TOOLS = [
	{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
	{ name: "bash", description: "Run a command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
];
const SYSTEM = "You are Plume, a coding agent.";
const SUMMARY = "## Goal & Original User Intent\n修好登录页。";

const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const said = (text: string): AssistantMessage => ({ role: "assistant", content: [{ type: "text", text }], api: PROVIDER.api, provider: PROVIDER.id, model: MODEL.modelId, usage: emptyUsage(), stopReason: "stop", timestamp: 2 });
const calls = (id: string, path: string): AssistantMessage => ({ ...said(""), content: [{ type: "toolCall", id, name: "read", arguments: { path } }], stopReason: "toolUse" });
const result = (id: string, text: string): Message => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text }], isError: false, timestamp: 3 });

/** 一段像样的历史：开头的请求，几轮读文件。 */
function history(): Message[] {
	const out: Message[] = [user(`登录页点了没反应，查一下原因并修好。${"背景说明".repeat(50)}`)];
	for (let i = 0; i < 4; i++) out.push(calls(`c${i}`, `src/login-${i}.ts`), result(`c${i}`, `export const step${i} = ${"1".repeat(400)};`));
	return out;
}

type Frame = Record<string, unknown>;
const sse = (frames: Frame[]) => frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}`).join("\n\n") + "\n\n";
const textReply = (text: string, input: number, cacheRead = 0) => sse([
	{ type: "message_start", message: { id: "m", usage: { input_tokens: input, cache_read_input_tokens: cacheRead, output_tokens: 1 } } },
	{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
	{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
	{ type: "content_block_stop", index: 0 },
	{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } },
	{ type: "message_stop" },
]);
const toolReply = sse([
	{ type: "message_start", message: { id: "m", usage: { input_tokens: 10, output_tokens: 1 } } },
	{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t9", name: "read", input: {} } },
	{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"path\":\"src/a.ts\"}" } },
	{ type: "content_block_stop", index: 0 },
	{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
	{ type: "message_stop" },
]);

/** 把 `globalThis.fetch` 换成按次序回答的桩，记下每次发出去的请求体。 */
async function withWire<T>(answers: string[], work: (sent: Array<Record<string, unknown>>) => Promise<T>): Promise<T> {
	const sent: Array<Record<string, unknown>> = [];
	const original = globalThis.fetch;
	globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
		if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
		sent.push(JSON.parse(String(init?.body)));
		return new Response(answers[Math.min(sent.length - 1, answers.length - 1)], { status: 200, headers: { "content-type": "text/event-stream" } });
	}) as typeof globalThis.fetch;
	try {
		return await work(sent);
	} finally {
		globalThis.fetch = original;
	}
}

/** 发一次主请求（走 `streamTurn`，和循环一样记下请求头和前缀指纹），返回会话状态图和这次的回复。 */
async function mainRequest(messages: Message[], thinking: string | undefined = "medium") {
	const state = new Map<string, unknown>();
	const turn = await streamTurn(
		{ provider: PROVIDER, model: MODEL, liveModel: undefined, thinking, cacheKey: "session-1", retryPolicy: undefined, streamFn: undefined, onContext: undefined, retryAttempts: 1 },
		{ systemPrompt: SYSTEM, messages, tools: TOOLS },
		{ signal: undefined, state },
		() => {},
	);
	return { state, reply: turn.message };
}

/** 去掉协议放的缓存断点：它跟着最后一条消息挪，不算内容（同 `prefix-fingerprint.ts`）。 */
function withoutBreakpoints(message: unknown): unknown {
	const { content, ...rest } = message as { content: unknown };
	return { ...rest, content: Array.isArray(content) ? content.map((block) => { const { cache_control: _b, ...kept } = block as Record<string, unknown>; return kept; }) : content };
}

test("the summary request is the previous request sent again with one instruction after it", async () => {
	await withWire([textReply("先看第五个文件。", 185_000), textReply(SUMMARY, 200, 185_000)], async (sent) => {
		const before = history();
		const { state, reply } = await mainRequest(before);
		const now = [...before, reply, user("继续")];
		const compacted = await compactIfNeeded({ messages: now, model: MODEL, provider: PROVIDER, streamFn: streamAssistant, lineage: lineageFrom(state, now) });

		assert.equal(sent.length, 2, "one turn, one summary — no independent retry");
		const [main, fork] = sent;
		for (const field of ["model", "tools", "system", "thinking", "metadata"]) assert.deepEqual(fork[field], main[field], `${field} unchanged`);
		const mainMessages = main.messages as unknown[];
		const forkMessages = fork.messages as unknown[];
		assert.ok(forkMessages.length > mainMessages.length);
		mainMessages.forEach((message, index) => assert.deepEqual(withoutBreakpoints(forkMessages[index]), withoutBreakpoints(message), `messages[${index}] unchanged`));
		assert.match(JSON.stringify(forkMessages.at(-1)), /Do not call any tools/, "the instruction is the last thing sent");
		assert.match(JSON.stringify(forkMessages.at(-1)), /Treat the conversation above/, "and it carries the untrusted-data warning the summary system prompt used to");

		assert.ok(compacted);
		assert.equal(compacted.via, "fork");
		assert.equal(compacted.summary, SUMMARY);
		assert.deepEqual(compacted.prefix?.change, undefined, "checked before sending, and it matched");
	});
});

test("a prefix that does not match is never sent; the summary goes the independent way", async () => {
	await withWire([textReply("先看第五个文件。", 185_000), textReply(SUMMARY, 200)], async (sent) => {
		const before = history();
		const { state, reply } = await mainRequest(before);
		const now = [...before, reply, user("继续")];
		// 本地拼出来的历史和上一次发出去的对不上——比如开头那条被改写了。
		const drifted = [user("另一句话"), ...now.slice(1)];
		const compacted = await compactIfNeeded({ messages: now, model: MODEL, provider: PROVIDER, streamFn: streamAssistant, lineage: lineageFrom(state, drifted) });

		assert.equal(sent.length, 2, "the mismatched fork never left: the second request is the independent one");
		assert.equal(sent[1].tools, undefined);
		assert.equal((sent[1].system as Array<{ text: string }>)[0].text, SUMMARY_SYSTEM);
		assert.ok(compacted);
		assert.equal(compacted.via, "independent");
		assert.equal(compacted.prefix?.change?.segment, "messages[0]", "and the mismatch is on record");
	});
});

test("a fork that calls a tool instead of summarising is discarded", async () => {
	await withWire([textReply("先看第五个文件。", 185_000), toolReply, textReply(SUMMARY, 200)], async (sent) => {
		const before = history();
		const { state, reply } = await mainRequest(before);
		const now = [...before, reply, user("继续")];
		const compacted = await compactIfNeeded({ messages: now, model: MODEL, provider: PROVIDER, streamFn: streamAssistant, lineage: lineageFrom(state, now) });

		assert.equal(sent.length, 3, "turn, discarded fork, independent summary");
		assert.equal(sent[2].tools, undefined);
		assert.ok(compacted);
		assert.equal(compacted.via, "independent");
		assert.equal(compacted.summary, SUMMARY);
	});
});

test("near the window a squeezed thinking budget changes the request head, so the fork is not sent", async () => {
	/*
	 * 输出上限按窗口剩下的折算（`contextMaxTokens`），budget_tokens 又不能超过它：主请求时还放得下
	 * 12288 的预算，分叉请求长了一截就放不下，thinking 参数跟着变——Anthropic 上那会让整段消息缓存失效。
	 * 前缀核对认出来，这次不发，走独立请求。
	 */
	const tight: ModelConfig = { ...MODEL, contextWindow: 64_000, maxOutputTokens: 16_000 };
	const provider = { ...PROVIDER, models: [tight] };
	await withWire([textReply("先看第五个文件。", 54_500), textReply(SUMMARY, 200)], async (sent) => {
		const before = history();
		const state = new Map<string, unknown>();
		const turn = await streamTurn(
			{ provider, model: tight, liveModel: undefined, thinking: "medium", cacheKey: "session-1", retryPolicy: undefined, streamFn: undefined, onContext: undefined, retryAttempts: 1 },
			{ systemPrompt: SYSTEM, messages: before, tools: TOOLS },
			{ signal: undefined, state },
			() => {},
		);
		const now = [...before, turn.message, user("继续")];
		const compacted = await compactIfNeeded({ messages: now, model: tight, provider, streamFn: streamAssistant, lineage: lineageFrom(state, now) });
		// 之后走哪条路不是这里要验的：这份夹具字很少、实测用量很大，独立请求按比例折算后也放不下，落到本地整理。
		assert.ok(sent.slice(1).every((body) => body.tools === undefined), "the fork never left");
		assert.notEqual(compacted?.via, "fork");
		assert.equal(compacted?.prefix?.change?.segment, "params");
	});
});

test("no fork when the cache has gone cold or the last request went to another model", async () => {
	for (const variant of ["cold", "other model"] as const) {
		await withWire([textReply("先看第五个文件。", 185_000), textReply(SUMMARY, 200)], async (sent) => {
			const before = history();
			const { state, reply } = await mainRequest(before);
			const now = [...before, reply, user("继续")];
			const lineage = lineageFrom(state, now)!;
			if (variant === "cold") lineage.sent.at -= FORK_HOT_MS + 1;
			// 上一次请求之后换了模型：缓存按模型分，那份前缀这个模型读不到。
			else lineage.sent.modelId = "anthropic/haiku";
			const compacted = await compactIfNeeded({ messages: now, model: MODEL, provider: PROVIDER, streamFn: streamAssistant, lineage });

			assert.equal(sent.length, 2, variant);
			assert.equal(sent[1].tools, undefined, `${variant}: straight to the independent request`);
			assert.equal(compacted?.via, "independent", variant);
		});
	}
});

test("the loop forks from the request it last sent: same prompt, same tools, its messages first", async () => {
	const contexts: Array<{ systemPrompt: string; tools: unknown[]; messages: Message[] }> = [];
	// 循环原地改写它的历史数组，记下的必须是发出那一刻的快照。
	const capture = (context: { systemPrompt: string; tools: unknown[]; messages: Message[] }) => contexts.push({ ...context, messages: [...context.messages] });
	let turns = 0;
	const window: ModelConfig = { ...MODEL, contextWindow: 40_000, maxOutputTokens: 4000, supportsThinking: false };
	const provider = { ...PROVIDER, models: [window] };
	const config = runConfig({
		session: {
			sessionId: "s",
			systemPrompt: SYSTEM,
			messages: [user("把四个文件都读一遍")],
			state: new Map(),
			compact: (messages, model, observer, options) => compactWith({
				messages, model, provider, observer, lineage: options?.lineage,
				streamFn: async function* (_p, _m, context) {
					capture(context);
					yield { type: "start" as const, partial: said("") };
					return said(SUMMARY);
				},
			}),
		},
		model: {
			provider, model: window,
			// 每轮都报一次刚过触发线（30k）的用量，第二轮开头就该压缩。
			streamFn: async (context) => {
				turns += 1;
				capture(context);
				if (turns > 3) return said("都读完了。");
				return { ...calls(`c${turns}`, `src/f${turns}.ts`), usage: { ...emptyUsage(), input: 30_500, total: 30_500 } };
			},
		},
		tools: { available: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "x".repeat(2000) }] }) }] as never },
	});
	await runAgent(config, () => {});

	const summaryAt = contexts.findIndex((context) => JSON.stringify(context.messages.at(-1)).includes("Do not call any tools"));
	assert.ok(summaryAt > 0, "a summary was asked for");
	const previous = contexts[summaryAt - 1];
	const fork = contexts[summaryAt];
	assert.equal(fork.systemPrompt, previous.systemPrompt);
	assert.deepEqual(fork.tools, previous.tools);
	assert.deepEqual(fork.messages.slice(0, previous.messages.length), previous.messages, "what was sent last time leads the fork, unchanged");
});
