/**
 * 下一步建议：一轮收尾后从上一次主请求分叉，猜人下一句；过时的、不像一句话的都不落地。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentEvent } from "../src/agent/events.ts";
import { DEFAULT_SETTINGS, type Settings } from "../src/config/settings.ts";
import { NEXT_PROMPT_INSTRUCTION, nextPromptText } from "../src/runtime/next-prompt.ts";
import { AgentSession } from "../src/runtime/session.ts";
import { SessionStore } from "../src/session/store.ts";
import { emptyUsage, type AssistantMessage, type LlmContext, type ModelConfig, type ProviderConfig } from "../src/types.ts";

const MODEL: ModelConfig = { id: "fake/model", providerId: "fake", modelId: "model", name: "Fake", contextWindow: 40_000, maxOutputTokens: 4000, supportsThinking: false, supportsImages: false, supportsTools: true };
const PROVIDER: ProviderConfig = { id: "fake", name: "Fake", baseUrl: "http://localhost", api: "openai-responses", apiKey: "x", enabled: true, models: [MODEL] };
const SETTINGS: Settings = { ...DEFAULT_SETTINGS, providers: [PROVIDER], defaultModelId: MODEL.id, mcpServers: [], permissionMode: "full", nextPromptSuggestions: true };

const reply = (text: string, cacheRead = 0): AssistantMessage => ({
	role: "assistant", content: [{ type: "text", text }], api: PROVIDER.api, provider: PROVIDER.id, model: MODEL.modelId,
	usage: { ...emptyUsage(), input: 100, cacheRead, total: 100 + cacheRead }, stopReason: "stop", timestamp: Date.now(),
});

const isFork = (context: LlmContext) => {
	const last = context.messages.at(-1);
	return last?.role === "user" && JSON.stringify(last.content).includes("guess the next message");
};

interface Wire {
	streamFn: (context: LlmContext) => Promise<AssistantMessage>;
	turns: LlmContext[];
	forks: LlmContext[];
	/** 建议请求在这里等，测试决定什么时候放它回来。 */
	release: () => void;
}

function provider(options: { cacheRead?: number; hold?: boolean } = {}): Wire {
	const turns: LlmContext[] = [];
	const forks: LlmContext[] = [];
	let release = () => {};
	const gate = options.hold ? new Promise<void>((resolve) => { release = resolve; }) : Promise.resolve();
	const streamFn = async (context: LlmContext): Promise<AssistantMessage> => {
		if (isFork(context)) {
			forks.push(context);
			const n = forks.length;
			await gate;
			return reply(`建议 ${n}`, 5000);
		}
		turns.push({ ...context, messages: [...context.messages] });
		return reply(`第 ${turns.length} 个回答`, options.cacheRead ?? 5000);
	};
	return { streamFn, turns, forks, release: () => release() };
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 100));
const suggestions = (events: AgentEvent[]) => events.flatMap((event) => event.type === "next_prompt" ? [event.text] : []);

async function withSession(
	options: { suggestNextPrompt?: boolean; compactWhenIdle?: boolean; settings?: Settings; wire?: Wire; rounds?: number },
	work: (session: AgentSession, events: AgentEvent[], wire: Wire) => Promise<void>,
) {
	const root = await mkdtemp(join(tmpdir(), "ly-next-prompt-"));
	const events: AgentEvent[] = [];
	const wire = options.wire ?? provider();
	const session = new AgentSession({
		cwd: root, settings: options.settings ?? SETTINGS, store: new SessionStore(join(root, "sessions")),
		emit: (event) => { events.push(event); }, streamFn: wire.streamFn, suggestNextPrompt: options.suggestNextPrompt ?? true,
		compactWhenIdle: options.compactWhenIdle,
	});
	await session.initialize();
	try {
		// 两轮：一条回复的对话不猜（`MIN_ASSISTANT_REPLIES`），第一轮收尾时什么也不发。
		await session.prompt([{ type: "text", text: "把登录页的按钮改成蓝色" }]);
		for (let round = 1; round < (options.rounds ?? 2); round++) await session.prompt([{ type: "text", text: `第 ${round + 1} 句` }]);
		await work(session, events, wire);
	} finally {
		wire.release();
		await session.dispose();
		await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
	}
}

test("after a clean turn the suggestion forks from the last request and lands as an event", async () => {
	await withSession({}, async (_session, events, wire) => {
		await until(() => suggestions(events).length > 0);
		assert.deepEqual(suggestions(events), ["建议 1"]);
		assert.ok(events.findLastIndex((event) => event.type === "agent_end") < events.findIndex((event) => event.type === "next_prompt"), "after the turn, not inside it");

		assert.equal(wire.forks.length, 1);
		const [fork] = wire.forks;
		const last = wire.turns.at(-1)!;
		assert.equal(fork.systemPrompt, last.systemPrompt, "same system prompt");
		assert.deepEqual(fork.tools, last.tools, "same tools");
		assert.deepEqual(fork.messages.slice(0, last.messages.length), last.messages, "the last request's messages lead");
		const tail = fork.messages.at(-1)!;
		assert.equal(tail.role === "user" && tail.content[0].type === "text" && tail.content[0].text, NEXT_PROMPT_INSTRUCTION);
	});
});

test("still asked when the host also compacts between turns, as the desktop does", async () => {
	// 收尾压缩一被叫到就占住会话；建议排在它后面登记的话，看到的永远是「忙」。
	await withSession({ compactWhenIdle: true }, async (_session, events) => {
		await until(() => suggestions(events).length > 0);
		assert.deepEqual(suggestions(events), ["建议 1"]);
	});
});

test("a conversation with a single reply is too short to guess from", async () => {
	await withSession({ rounds: 1 }, async (_session, events, wire) => {
		await settle();
		assert.equal(wire.forks.length, 0);
		assert.deepEqual(suggestions(events), []);
	});
});

test("off in settings, nothing is asked", async () => {
	await withSession({ settings: { ...SETTINGS, nextPromptSuggestions: false } }, async (_session, events, wire) => {
		await settle();
		assert.equal(wire.forks.length, 0);
		assert.deepEqual(suggestions(events), []);
	});
});

test("without the host asking for it, nothing is asked", async () => {
	await withSession({ suggestNextPrompt: false }, async (_session, _events, wire) => {
		await settle();
		assert.equal(wire.forks.length, 0);
	});
});

test("a provider that never reported the cache is not asked: the fork would reread the whole conversation at full price", async () => {
	await withSession({ wire: provider({ cacheRead: 0 }) }, async (_session, _events, wire) => {
		await settle();
		assert.equal(wire.forks.length, 0);
	});
});

test("a suggestion still on its way when the person speaks again is dropped", async () => {
	await withSession({ wire: provider({ hold: true }) }, async (session, events, wire) => {
		await until(() => wire.forks.length === 1);
		const next = session.prompt([{ type: "text", text: "再把字号调大一点" }]);
		await until(() => wire.turns.length === 3);
		wire.release();
		await next;
		// 第二轮收尾后又猜了一次，落地的只有那一次。
		await until(() => suggestions(events).length > 0);
		await settle();
		assert.deepEqual(suggestions(events), ["建议 2"]);
	});
});

test("only a single short line written as the person is kept", () => {
	const reply = (text: string, extra: Partial<AssistantMessage> = {}): AssistantMessage => ({
		role: "assistant", content: [{ type: "text", text }], api: PROVIDER.api, provider: PROVIDER.id, model: MODEL.modelId,
		usage: emptyUsage(), stopReason: "stop", timestamp: 0, ...extra,
	});
	assert.equal(nextPromptText(reply("提交这次改动")), "提交这次改动");
	assert.equal(nextPromptText(reply("「提交这次改动」")), "提交这次改动", "quotes are stripped");
	assert.equal(nextPromptText(reply("<think>嗯</think>run the tests")), "run the tests");
	assert.equal(nextPromptText(reply("继续")), "继续", "two characters are a whole Chinese reply");
	assert.equal(nextPromptText(reply("yes")), "yes", "a word people do type alone");
	assert.equal(nextPromptText(reply("/review")), "/review", "a command");
	assert.equal(nextPromptText(reply("跑一下测试。")), "跑一下测试。", "a full stop at the end is still one sentence");

	const dropped: [string, string][] = [
		["", "empty"],
		["无", "said nothing in words"],
		["（没有建议）", "a note about itself"],
		["No suggestion.", "a note about itself"],
		["建议：跑一下测试", "a label"],
		["Suggestion: run the tests", "a label"],
		["**跑测试**", "formatting"],
		["第一步\n第二步", "more than one line"],
		["好", "half a word"],
		["tests", "half a sentence"],
		["这是一句远远超过三十个字的建议，模型没有照着说的去写而是写了一大段解释", "too long for Chinese"],
		["please go and run every single one of the integration tests again right now", "too many words"],
		["先跑测试。再提交", "two sentences"],
		["Run the tests. Then commit.", "two sentences"],
		["看起来不错", "an evaluation"],
		["Looks good to me", "an evaluation"],
		["谢谢，跑一下测试", "thanks"],
		["I'll run the tests now", "the assistant's voice"],
		["Let me check the logs", "the assistant's voice"],
		["我来跑一下测试", "the assistant's voice"],
		["你可以运行测试", "telling the person what they could do"],
	];
	for (const [text, why] of dropped) assert.equal(nextPromptText(reply(text)), null, `${JSON.stringify(text)}: ${why}`);
	assert.equal(nextPromptText(reply("跑测试", { stopReason: "length" })), null, "cut off");
	assert.equal(nextPromptText({ ...reply("跑测试"), content: [{ type: "toolCall", id: "1", name: "bash", arguments: {} }] }), null);
});
