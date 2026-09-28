/**
 * The trajectory: one stream, read four ways.
 *
 * These tests hold the properties that make it worth having — that a reply's reasoning and its
 * words are separate things, that a voided tail stays gone, that forking does not disturb what it
 * forked from, and that all of it comes from the same file the model's turn was written to.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionStore } from "../src/session/store.ts";
import {
	countBySource,
	filterTrajectory,
	forkSession,
	matchRanges,
	messagesUpTo,
	readTrajectory,
} from "../src/trajectory/index.ts";
import type { AssistantMessage, Message, ModelConfig, ProviderConfig } from "../src/types.ts";
import { emptyUsage } from "../src/types.ts";
import { measureTotal } from "../src/runtime/context.ts";
import { SessionLog } from "../src/runtime/session-log.ts";
import { modelHistory } from "../src/runtime/session-turn.ts";
import { estimateTokens } from "../src/tokens.ts";

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "fake",
		model: "model",
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: 1,
	};
}

async function seeded() {
	const root = await mkdtemp(join(tmpdir(), "ly-traj-"));
	const store = new SessionStore(join(root, "sessions"));
	let meta = await store.create(root, "fake/model");

	const user: Message = { role: "user", content: [{ type: "text", text: "查一下构建为什么慢" }], timestamp: 1 };
	meta = await store.append(meta, { type: "message", message: user });
	meta = await store.append(meta, {
		type: "event",
		event: { type: "context", systemPrompt: "You are Lyra.", tools: ["bash", "read"], skills: [] },
	});
	meta = await store.append(meta, {
		type: "message",
		message: assistant([
			{ type: "thinking", thinking: "缓存大概是冷的" },
			{ type: "text", text: "先看构建日志" },
			{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm run build" } },
		]),
	});
	meta = await store.append(meta, {
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: "c1",
			content: [{ type: "text", text: "cache miss on every module" }],
			timestamp: 2,
		} as Message,
	});

	return { store, meta, root, cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 8 }) };
}

test("a reply's reasoning, its words and its tool call are three separate entries", async () => {
	const h = await seeded();
	try {
		const entries = await readTrajectory(h.store, h.meta.projectId, h.meta.id);
		const sources = entries.map((entry) => entry.source);

		assert.deepEqual(sources, ["user", "system", "context", "thinking", "assistant", "tool-call", "tool-result"]);
		// The three that came from one record share its sequence, which is how they are known to
		// have arrived together.
		const fromReply = entries.filter((entry) => ["thinking", "assistant", "tool-call"].includes(entry.source));
		assert.equal(new Set(fromReply.map((entry) => entry.seq)).size, 1);
	} finally {
		await h.cleanup();
	}
});

test("a command is carried out of the argument object, so it can be read as a command", async () => {
	const h = await seeded();
	try {
		const entries = await readTrajectory(h.store, h.meta.projectId, h.meta.id);
		const call = entries.find((entry) => entry.source === "tool-call");
		assert.equal(call?.command, "npm run build");
		assert.equal(call?.summary, "bash npm run build", "and it is what the row says, not a JSON blob");
		assert.equal(call?.detail, "", "with nothing left over when the command was the only argument");
	} finally {
		await h.cleanup();
	}
});

test("a tool result can be traced back to the call it answers", async () => {
	const h = await seeded();
	try {
		const entries = await readTrajectory(h.store, h.meta.projectId, h.meta.id);
		const call = entries.find((entry) => entry.source === "tool-call");
		const result = entries.find((entry) => entry.source === "tool-result");
		assert.equal(call?.correlationId, "c1");
		assert.equal(result?.correlationId, "c1");
	} finally {
		await h.cleanup();
	}
});

test("filtering by source and by words compose", async () => {
	const h = await seeded();
	try {
		const entries = await readTrajectory(h.store, h.meta.projectId, h.meta.id);

		assert.equal(filterTrajectory(entries, { sources: ["thinking"] }).length, 1);
		assert.deepEqual(filterTrajectory(entries, { query: "cache miss" }).map(entry => entry.source), ["tool-call", "tool-result"], "paired call details are searchable too");
		assert.equal(filterTrajectory(entries, { sources: ["user"], query: "cache miss" }).length, 0);

		const counts = countBySource(entries);
		assert.equal(counts["tool-call"], 1);
		assert.equal(counts.system, 1);
	} finally {
		await h.cleanup();
	}
});

test("the system prompt is kept whole, so it can be read back", async () => {
	const h = await seeded();
	try {
		const entries = await readTrajectory(h.store, h.meta.projectId, h.meta.id);
		const system = entries.find((entry) => entry.source === "system");
		assert.equal(system?.detail, "You are Lyra.");
	} finally {
		await h.cleanup();
	}
});

test("a voided tail does not appear in the trajectory", async () => {
	const h = await seeded();
	try {
		const before = await readTrajectory(h.store, h.meta.projectId, h.meta.id);
		const cutoff = before[0].seq;

		await h.store.append(h.meta, { type: "truncate", afterSeq: cutoff });
		const after = await readTrajectory(h.store, h.meta.projectId, h.meta.id);

		assert.equal(after.length, 1, "only the first message survives");
		assert.equal(after[0].source, "user");
	} finally {
		await h.cleanup();
	}
});

test("forking copies the history up to a point and leaves the original alone", async () => {
	const h = await seeded();
	try {
		const entries = await readTrajectory(h.store, h.meta.projectId, h.meta.id);
		const atReply = entries.find((entry) => entry.source === "assistant");
		assert.ok(atReply);

		const fork = await forkSession(h.store, h.meta.projectId, h.meta.id, atReply.seq);
		assert.ok(fork);
		assert.equal(fork.messages, 2, "the question and the reply, not the tool result after them");

		const forked = await messagesUpTo(h.store, fork.meta.projectId, fork.meta.id, Number.POSITIVE_INFINITY);
		assert.deepEqual(
			forked.map((message) => message.role),
			["user", "assistant"],
		);

		// The original still has everything.
		const original = await messagesUpTo(h.store, h.meta.projectId, h.meta.id, Number.POSITIVE_INFINITY);
		assert.equal(original.length, 3);
	} finally {
		await h.cleanup();
	}
});

/** 一段压缩过的会话：25 条原文、边界只保留最后 4 条，边界之后又有一问一答，回复带着压缩后请求的 usage。 */
async function compacted() {
	const root = await mkdtemp(join(tmpdir(), "ly-traj-compacted-"));
	const store = new SessionStore(join(root, "sessions"));
	const meta = await store.create(root, "fake/model");
	const log = new SessionLog(store, async () => {}, meta);
	const say = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
	await log.commit(say("目标：修复登录"));
	for (let i = 0; i < 24; i++) await log.commit({ ...assistant([{ type: "text", text: `Details ${i}: ${"implementation ".repeat(180)}` }]), timestamp: Date.now() });
	await log.emit({ type: "compacted", before: 25, after: 6, summary: "之前修了登录的前半段。", kept: 4 });
	const beforeBoundary = (await store.load(meta.projectId, meta.id))!.meta.seq - 1;
	await new Promise((resolve) => setTimeout(resolve, 10));
	await log.commit(say("继续"));
	await log.commit({ ...assistant([{ type: "text", text: "好" }]), usage: { ...emptyUsage(), input: 2500 }, timestamp: Date.now() });
	return { store, meta: log.meta, beforeBoundary, cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 8 }) };
}

const tight: ModelConfig = { id: "fake/model", providerId: "fake", modelId: "model", name: "Fake", contextWindow: 10_000, maxOutputTokens: 2000, supportsThinking: false, supportsImages: false, supportsTools: true };
const fake: ProviderConfig = { id: "fake", name: "Fake", api: "openai-responses", apiKey: "k", baseUrl: "http://localhost", enabled: true, models: [tight] };
const viewText = (messages: Message[]) => messages.flatMap((message) => message.content).map((block) => (block.type === "text" ? block.text : "")).join("\n");

async function restoredView(store: SessionStore, meta: { projectId: string; id: string }) {
	const loaded = await store.load(meta.projectId, meta.id);
	assert.ok(loaded);
	const log = new SessionLog(store, async () => {}, loaded.meta);
	log.restore(loaded.messages, loaded.compaction);
	return { loaded, view: modelHistory(log, fake, tight) };
}

test("a fork past a compaction carries the boundary, so the model sees what the original saw there", async () => {
	// 只抄消息时分叉的模型视图展开回 27 条原文（估算两万多），计量却还报压缩后那条回复的 2,500。
	const h = await compacted();
	try {
		const fork = await forkSession(h.store, h.meta.projectId, h.meta.id, h.meta.seq);
		assert.ok(fork);
		const original = await restoredView(h.store, h.meta);
		const forked = await restoredView(h.store, fork.meta);

		assert.equal(forked.loaded.messages.length, 27, "the transcript is still copied whole");
		assert.deepEqual(forked.loaded.compaction && { summary: forked.loaded.compaction.summary, keptFrom: forked.loaded.compaction.keptFrom }, { summary: original.loaded.compaction!.summary, keptFrom: original.loaded.compaction!.keptFrom });
		assert.deepEqual(forked.loaded.compactions, original.loaded.compactions, "the divider sits where it did");
		assert.equal(viewText(forked.view), viewText(original.view));
		const total = measureTotal(forked.view);
		assert.ok(total.tokens >= estimateTokens(forked.view), `metering ${total.tokens} must not undercount the view it describes`);
	} finally {
		await h.cleanup();
	}
});

test("a fork from before the compaction was written opens on the full history", async () => {
	const h = await compacted();
	try {
		const fork = await forkSession(h.store, h.meta.projectId, h.meta.id, h.beforeBoundary);
		assert.ok(fork);
		const forked = await restoredView(h.store, fork.meta);
		assert.equal(forked.loaded.compaction, null, "at that point nothing had been summarised yet");
		assert.equal(forked.view.length, 25);
	} finally {
		await h.cleanup();
	}
});

test("match ranges point at every occurrence, for highlighting", () => {
	const ranges = matchRanges("cache miss, then another cache miss", "cache");
	assert.deepEqual(ranges, [
		{ start: 0, end: 5 },
		{ start: 25, end: 30 },
	]);
	assert.deepEqual(matchRanges("anything", "  "), [], "an empty query matches nothing, not everything");
});

test("forking rejects a mismatched project without creating an empty conversation", async () => {
	const h = await seeded();
	try {
		const before = await h.store.listSessions();
		assert.equal(await forkSession(h.store, "wrong-project", h.meta.id, 1), null);
		assert.deepEqual(await h.store.listSessions(), before);
	} finally { await h.cleanup(); }
});
