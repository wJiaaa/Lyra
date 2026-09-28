import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../src/config/settings.ts";
import type { SettledDispatch } from "../src/runtime/delegation-waits.ts";
import { AgentSession } from "../src/runtime/session.ts";
import { SessionStore } from "../src/session/store.ts";
import { emptyUsage, type AssistantMessage, type Message, type ModelConfig, type ProviderConfig } from "../src/types.ts";

const model: ModelConfig = { id: "qa/model", modelId: "model", providerId: "qa", name: "QA", contextWindow: 1_000_000, maxOutputTokens: 1000, supportsThinking: false, supportsImages: false, supportsTools: false };
const provider: ProviderConfig = { id: "qa", name: "QA", api: "anthropic-messages", baseUrl: "http://localhost", apiKey: "test", enabled: true, models: [model] };
function reply(text: string): AssistantMessage {
	return { role: "assistant", content: [{ type: "text", text }], api: provider.api, provider: provider.id, model: model.modelId, stopReason: "stop", usage: emptyUsage(), timestamp: Date.now() };
}

test("manual commands carry focus instructions, are single-flight, and persist a result without adding model prompts", async () => {
	const root = await mkdtemp(join(tmpdir(), "plume-manual-compact-"));
	const store = new SessionStore(join(root, "sessions"));
	const meta = await store.create(root, model.id);
	let finish!: (message: AssistantMessage) => void;
	let requested!: () => void;
	const received = new Promise<void>((resolve) => { requested = resolve; });
	const response = new Promise<AssistantMessage>((resolve) => { finish = resolve; });
	let requests = 0;
	let instructions = "";
	const session = new AgentSession({ cwd: root, store, meta, settings: { ...DEFAULT_SETTINGS, providers: [provider], defaultModelId: model.id }, emit: () => {},
		streamFn: async (context) => {
			requests++;
			instructions = JSON.stringify(context.messages.at(-1));
			requested(); return response;
		} });
	try {
		for (let index = 0; index < 20; index++) await session.log.commit(index % 2 ? reply("Implementation notes. ".repeat(100)) : { role: "user", content: [{ type: "text", text: "Preserve this task. ".repeat(100) }], timestamp: index });
		const before = await session.contextBreakdown();
		const first = session.compact("保留当前决策和待办");
		const second = session.compact("do not duplicate");
		assert.equal(first, second);
		await received;
		assert.equal(session.running, true);
		assert.match(instructions, /保留当前决策和待办/);
		assert.equal(session.log.commandRuns[0].status, "running");
		finish(reply("Task, decisions and outstanding work retained."));
		const result = await first;
		assert.equal(result.ok, true);
		assert.equal(requests, 1); assert.equal(session.running, false);
		assert.equal(session.messages.length, 20);
		const after = await session.contextBreakdown();
		assert.ok(before && after && after.used < before.used * 0.7, JSON.stringify({ before: before?.used, after: after?.used }));
		const loaded = await store.load(meta.projectId, meta.id);
		assert.ok(loaded?.compaction);
		assert.equal(loaded.commandRuns?.length, 1);
		assert.equal(loaded.commandRuns?.[0].status, "done");
		assert.equal(loaded.commandRuns?.[0].input, "/compact 保留当前决策和待办");
		const reopened = new AgentSession({ cwd: root, store, meta: loaded.meta, settings: { ...DEFAULT_SETTINGS, providers: [provider], defaultModelId: model.id }, emit: () => {} });
		reopened.restore(loaded.messages, loaded.compaction);
		const restored = await reopened.contextBreakdown();
		assert.equal(restored?.used, after.used, "cold restore must retain the compacted reading");
		assert.equal(restored?.measured, false);
		assert.ok(loaded.compaction.at);
		const freshReply = reply("A reply measured after compaction.");
		freshReply.timestamp = loaded.compaction.at + 1;
		freshReply.usage = { ...emptyUsage(), input: 20_000, output: 300 };
		await reopened.log.commit(freshReply);
		for (let read = 0; read < 2; read++) {
			const measured = await reopened.contextBreakdown();
			assert.equal(measured?.used, 20_300, "new usage must replace the estimate on every read");
			assert.equal(measured?.measured, true);
		}
	} finally { finish?.(reply("stop")); await rm(root, { recursive: true, force: true }); }
});

test("cancellation and provider failure keep the previous history boundary and end the busy state", async () => {
	for (const outcome of ["cancelled", "failed", "empty"]) {
		const root = await mkdtemp(join(tmpdir(), "plume-compact-failure-"));
		const store = new SessionStore(join(root, "sessions"));
		const meta = await store.create(root, model.id);
		let fail!: (error: Error) => void;
		let finish!: (message: AssistantMessage) => void;
		let requested!: () => void;
		const received = new Promise<void>((resolve) => { requested = resolve; });
		const response = new Promise<AssistantMessage>((resolve, reject) => { finish = resolve; fail = reject; });
		const session = new AgentSession({ cwd: root, store, meta, settings: { ...DEFAULT_SETTINGS, providers: [provider], defaultModelId: model.id }, emit: () => {}, streamFn: async () => { requested(); return response; } });
		try {
			for (let index = 0; index < 20; index++) await session.log.commit(index % 2 ? reply("notes ".repeat(300)) : { role: "user", content: [{ type: "text", text: "requirements ".repeat(200) }], timestamp: index });
			const pending = session.compact(); await received;
			if (outcome === "cancelled") session.abort();
			if (outcome === "empty") finish(reply("")); else fail(new Error("provider unavailable"));
			assert.equal((await pending).ok, false);
			assert.equal(session.log.compaction, null);
			assert.equal(session.running, false);
			assert.equal(session.log.commandRuns[0].status, outcome === "cancelled" ? "cancelled" : "failed");
			assert.match(session.log.commandRuns[0].detail, outcome === "cancelled" ? /取消/ : outcome === "empty" ? /摘要.*空/ : /provider unavailable/);
		} finally { await rm(root, { recursive: true, force: true }); }
	}
});

test("interrupted command replay settles once and rewind removes only records after the retained history", async () => {
	const root = await mkdtemp(join(tmpdir(), "plume-command-replay-"));
	const store = new SessionStore(join(root, "sessions"));
	const meta = await store.create(root, model.id);
	const session = new AgentSession({ cwd: root, store, meta, settings: DEFAULT_SETTINGS, emit: () => {} });
	try {
		await session.log.commit({ role: "user", content: [{ type: "text", text: "first" }], timestamp: 1 });
		const command = { id: "manual-1", name: "compact", input: "/compact", timestamp: 2, at: 1, status: "running", detail: "正在压缩会话…" } satisfies import("../src/agent/events.ts").CommandRun;
		await session.log.emit({ type: "command_status", command });
		assert.equal((await store.load(meta.projectId, meta.id))?.commandRuns?.[0].status, "cancelled");
		await session.log.emit({ type: "command_status", command: { ...command, status: "done", detail: "完成" } });
		await session.log.commit(reply("first reply"));
		await session.log.emit({ type: "command_status", command: { ...command, id: "manual-2", at: 2, status: "done" } });
		await session.log.commit({ role: "user", content: [{ type: "text", text: "second" }], timestamp: 3 });
		await session.log.emit({ type: "command_status", command: { ...command, id: "manual-3", at: 3 } });
		assert.equal((await store.load(meta.projectId, meta.id))?.commandRuns?.length, 3);
		await session.log.truncateFrom(2);
		const loaded = await store.load(meta.projectId, meta.id);
		assert.deepEqual(loaded?.commandRuns, session.log.commandRuns);
		assert.deepEqual(loaded?.commandRuns?.map((run) => [run.id, run.status]), [["manual-1", "done"], ["manual-2", "done"]]);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("a prompt submitted during manual compaction waits for the new boundary and is delivered once", async () => {
	const root = await mkdtemp(join(tmpdir(), "plume-compact-queued-"));
	const store = new SessionStore(join(root, "sessions"));
	const meta = await store.create(root, model.id);
	let finish!: (message: AssistantMessage) => void;
	let requested!: () => void;
	const received = new Promise<void>((resolve) => { requested = resolve; });
	const summary = new Promise<AssistantMessage>((resolve) => { finish = resolve; });
	const seen: Message[][] = [];
	const session = new AgentSession({ cwd: root, store, meta, settings: { ...DEFAULT_SETTINGS, providers: [provider], defaultModelId: model.id }, emit: () => {},
		streamFn: async (context) => {
			seen.push([...context.messages]);
			if (seen.length === 1) { requested(); return summary; }
			return reply("Done.");
		} });
	try {
		await session.initialize();
		for (let index = 0; index < 20; index++) await session.log.commit(index % 2 ? reply("notes ".repeat(300)) : { role: "user", content: [{ type: "text", text: "requirements ".repeat(200) }], timestamp: index });
		const compaction = session.compact(); await received;
		const prompt = session.prompt([{ type: "text", text: "Continue once after compaction." }]);
		assert.equal(seen.length, 1);
		assert.equal(session.messages.length, 20);
		finish(reply("Retained task and decisions."));
		assert.equal((await compaction).ok, true); await prompt;
		assert.equal(seen.length, 2);
		assert.ok(seen[1].length < 20);
		assert.match(JSON.stringify(seen[1]), /<session-summary>/);
		assert.equal(session.messages.filter((message) => message.role === "user" && message.content.some((block) => block.type === "text" && block.text === "Continue once after compaction.")).length, 1);
		assert.equal(session.running, false);
	} finally {
		finish?.(reply("stop")); await session.dispose();
		await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
	}
});

test("后台报告等压缩时人按了停止：压缩取消，报告也不再开回合", async () => {
	const root = await mkdtemp(join(tmpdir(), "plume-compact-delivery-stop-"));
	const store = new SessionStore(join(root, "sessions"));
	const meta = await store.create(root, model.id);
	let finish!: (message: AssistantMessage) => void;
	let requested!: () => void;
	const received = new Promise<void>((resolve) => { requested = resolve; });
	const summary = new Promise<AssistantMessage>((resolve) => { finish = resolve; });
	let requests = 0;
	const session = new AgentSession({ cwd: root, store, meta, settings: { ...DEFAULT_SETTINGS, providers: [provider], defaultModelId: model.id }, emit: () => {},
		streamFn: async () => {
			requests++;
			if (requests === 1) { requested(); return summary; }
			return reply("Merged the background report.");
		} });
	// 送达走的是私有的那条路：从登记簿取出报告、等压缩、再提交。这里直接驱动它，让报告落在「已取出、正等压缩」的那一格。
	const internals = session as unknown as { collectDelivery(report: SettledDispatch): void; flushDeliveries(): Promise<void> };
	try {
		await session.initialize();
		for (let index = 0; index < 20; index++) await session.log.commit(index % 2 ? reply("notes ".repeat(300)) : { role: "user", content: [{ type: "text", text: "requirements ".repeat(200) }], timestamp: index });
		const compaction = session.compact(); await received;
		internals.collectDelivery({ id: "bg-1", error: "background worker crashed" });
		const delivering = internals.flushDeliveries();
		session.abort();
		finish(reply("Retained task and decisions."));
		assert.equal((await compaction).ok, false);
		await delivering;
		assert.equal(requests, 1, "停止之后不该再有模型请求");
		assert.ok(!session.messages.some((message) => message.role === "user" && message.delivery), "也没有送达消息进历史");
		assert.equal(session.running, false);
	} finally {
		finish?.(reply("stop")); await session.dispose();
		await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
	}
});
