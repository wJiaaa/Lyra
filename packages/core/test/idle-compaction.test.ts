/**
 * 会话层的两处分叉：一轮收尾、缓存还热时先压掉越线的历史；`/compact` 也从上一次请求分叉。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentEvent } from "../src/agent/events.ts";
import { DEFAULT_SETTINGS, type Settings } from "../src/config/settings.ts";
import { AgentSession } from "../src/runtime/session.ts";
import { SessionStore } from "../src/session/store.ts";
import { emptyUsage, type AssistantMessage, type LlmContext, type ModelConfig, type ProviderConfig } from "../src/types.ts";

// 触发线 30k（40k 减去摘要要的 8k 和余量 2k，比 80% 更早）。
const MODEL: ModelConfig = { id: "fake/model", providerId: "fake", modelId: "model", name: "Fake", contextWindow: 40_000, maxOutputTokens: 4000, supportsThinking: false, supportsImages: false, supportsTools: true };
const PROVIDER: ProviderConfig = { id: "fake", name: "Fake", baseUrl: "http://localhost", api: "openai-responses", apiKey: "x", enabled: true, models: [MODEL] };
const SETTINGS: Settings = { ...DEFAULT_SETTINGS, providers: [PROVIDER], defaultModelId: MODEL.id, mcpServers: [], permissionMode: "full" };
const SUMMARY = "## Goal & Original User Intent\n回答四个问题。";
const PROMPTS = 4;

const reply = (text: string, input = 0): AssistantMessage => ({
	role: "assistant", content: [{ type: "text", text }], api: PROVIDER.api, provider: PROVIDER.id, model: MODEL.modelId,
	usage: { ...emptyUsage(), input, total: input }, stopReason: "stop", timestamp: Date.now(),
});

/** 主请求照常回答，最后一轮报一个越线的用量；末尾是摘要指令的就交摘要。记下每个摘要请求。 */
function provider() {
	const summaries: LlmContext[] = [];
	const turns: LlmContext[] = [];
	const streamFn = async (context: LlmContext): Promise<AssistantMessage> => {
		const last = context.messages.at(-1);
		if (last?.role === "user" && JSON.stringify(last.content).includes("## Goal & Original User Intent")) {
			summaries.push(context);
			return reply(SUMMARY);
		}
		turns.push({ ...context, messages: [...context.messages] });
		return reply(`第 ${turns.length} 个回答`, turns.length === PROMPTS ? 31_000 : 1000);
	};
	return { streamFn, summaries, turns };
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function withSession(options: { compactWhenIdle?: boolean }, work: (session: AgentSession, events: AgentEvent[], wire: ReturnType<typeof provider>) => Promise<void>) {
	const root = await mkdtemp(join(tmpdir(), "ly-idle-compact-"));
	const events: AgentEvent[] = [];
	const wire = provider();
	const session = new AgentSession({ cwd: root, settings: SETTINGS, store: new SessionStore(join(root, "sessions")), emit: (event) => { events.push(event); }, streamFn: wire.streamFn, ...options });
	await session.initialize();
	try {
		for (let i = 0; i < PROMPTS; i++) await session.prompt([{ type: "text", text: `问题 ${i}：${"请详细说明".repeat(400)}` }]);
		await work(session, events, wire);
	} finally {
		await session.dispose();
		await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
	}
}

test("a turn that ends over the line is compacted right away, forked from its last request", async () => {
	await withSession({ compactWhenIdle: true }, async (session, events, wire) => {
		await until(() => events.some((event) => event.type === "compacted"));
		const compacted = events.find((event) => event.type === "compacted");
		assert.equal(compacted?.type === "compacted" && compacted.via, "fork");
		assert.ok(events.findLastIndex((event) => event.type === "agent_end") < events.indexOf(compacted!), "after the turn, not inside it");

		assert.equal(wire.summaries.length, 1);
		const [summary] = wire.summaries;
		const last = wire.turns.at(-1)!;
		assert.equal(summary.systemPrompt, last.systemPrompt, "same system prompt");
		assert.deepEqual(summary.tools, last.tools, "same tools");
		assert.deepEqual(summary.messages.slice(0, last.messages.length), last.messages, "the last request's messages lead");

		await until(() => session.log.compaction !== null);
		assert.equal(session.log.compaction?.summary, SUMMARY, "and the boundary is written down");
	});
});

test("without the host asking for it, nothing is compacted between turns", async () => {
	await withSession({}, async (_session, events, wire) => {
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(events.some((event) => event.type === "compacted"), false);
		assert.equal(wire.summaries.length, 0);
	});
});

test("/compact forks from the last request while the cache is warm", async () => {
	await withSession({}, async (session, events, wire) => {
		const outcome = await session.compact();
		assert.ok(outcome.ok, JSON.stringify(outcome));
		const compacted = events.find((event) => event.type === "compacted");
		assert.equal(compacted?.type === "compacted" && compacted.via, "fork");
		assert.equal(wire.summaries.length, 1);
		assert.ok(wire.summaries[0].tools.length > 0, "the main request's tools ride along");
		assert.equal(wire.summaries[0].systemPrompt, wire.turns.at(-1)!.systemPrompt);
	});
});
