import assert from "node:assert/strict";
import { appendFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionStore } from "../src/session/store.ts";
import type { Message } from "../src/types.ts";
import type { AssistantMessage } from "../src/types.ts";
import { emptyUsage } from "../src/types.ts";

function toolResult(id: string): Message {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "bash",
		content: [{ type: "text", text: id }],
		isError: false,
		timestamp: Date.now(),
	};
}

function assistant(): AssistantMessage {
	return { role: "assistant", content: [{ type: "text", text: "ok" }], api: "openai-responses", provider: "p", model: "m", stopReason: "stop", usage: emptyUsage(), timestamp: 1 };
}

test("concurrent appends get distinct, gapless sequence numbers", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ly-store-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const store = new SessionStore(root);

	const meta = await store.create("/tmp/project", "model");

	// Parallel tool calls all persist from the same stale snapshot. Every record must still
	// land on its own sequence number, or a client syncing with ?since=N silently loses one.
	await Promise.all([
		store.append(meta, { type: "message", message: toolResult("a") }),
		store.append(meta, { type: "message", message: toolResult("b") }),
		store.append(meta, { type: "message", message: toolResult("c") }),
	]);

	const seqs: number[] = [];
	for await (const record of store.read(meta.projectId, meta.id)) seqs.push(record.seq);

	assert.deepEqual(seqs, [1, 2, 3, 4], "sequence numbers must be unique and contiguous");

	const loaded = await store.load(meta.projectId, meta.id);
	assert.equal(loaded?.messages.length, 3);
	assert.equal(loaded?.meta.messageCount, 3);
});

test("incremental read returns every record after the given sequence", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ly-store-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const store = new SessionStore(root);

	const meta = await store.create("/tmp/project", "model");
	await Promise.all([
		store.append(meta, { type: "message", message: toolResult("a") }),
		store.append(meta, { type: "message", message: toolResult("b") }),
		store.append(meta, { type: "message", message: toolResult("c") }),
	]);

	const after: number[] = [];
	for await (const record of store.read(meta.projectId, meta.id, 1)) after.push(record.seq);
	assert.deepEqual(after, [2, 3, 4], "a client that has seen seq 1 must receive all three results");
});

test("reopening a session continues numbering instead of restarting", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ly-store-"));
	t.after(() => rm(root, { recursive: true, force: true }));

	const first = new SessionStore(root);
	const meta = await first.create("/tmp/project", "model");
	await first.append(meta, { type: "message", message: toolResult("a") });

	// A fresh process (app restart) must not reuse sequence numbers already on disk.
	const second = new SessionStore(root);
	const loaded = await second.load(meta.projectId, meta.id);
	assert.ok(loaded);
	const next = await second.append(loaded.meta, { type: "message", message: toolResult("b") });
	assert.equal(next.seq, 3);
});

test("the first record after a crash that cut the last line short is not lost with it", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ly-store-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const first = new SessionStore(root);
	const meta = await first.create("/tmp/project", "model");
	await first.append(meta, { type: "message", message: toolResult("a") });
	const file = (await readdir(join(root, meta.projectId))).find((name) => name.startsWith(meta.id));
	assert.ok(file);
	// 进程在写一条记录的中途被杀：末行没有写完，也没有换行。
	await appendFile(join(root, meta.projectId, file), '{"seq":3,"ts":1,"type":"mess');

	const second = new SessionStore(root);
	const loaded = await second.load(meta.projectId, meta.id);
	assert.ok(loaded);
	await second.append(loaded.meta, { type: "truncate", afterSeq: 1 });
	await second.append(loaded.meta, { type: "message", message: toolResult("b") });
	const types: string[] = [];
	for await (const record of new SessionStore(root).read(meta.projectId, meta.id)) types.push(record.type);
	assert.deepEqual(types.slice(-2), ["truncate", "message"], "崩溃后写的第一条（这里是一次撤回）没有和半截行拼在一起丢掉");
});

test("a rewind to exactly the compaction boundary keeps it, running and after a restart alike", async (t) => {
	const { SessionLog } = await import("../src/runtime/session-log.ts");
	const root = await mkdtemp(join(tmpdir(), "ly-store-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const store = new SessionStore(root);
	const log = new SessionLog(store, () => {}, await store.create("/tmp/project", "model"));
	const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
	const call = (id: string): AssistantMessage => ({ ...assistant(), stopReason: "toolUse", content: [{ type: "toolCall", id, name: "bash", arguments: {}, argumentsText: "{}" }] });
	for (const message of [user("0"), assistant(), user("2"), call("c"), toolResult("c"), assistant(), user("6"), assistant()]) await log.commit(message);
	await log.emit({ type: "compacted", before: 8, after: 3, kept: 2, summary: "S" });
	assert.equal(log.compaction?.keptFrom, 6);

	// 编辑保留尾部的第一条：截在边界上，摘要覆盖的消息都还在。
	await log.truncateFrom(6);
	const reloaded = await new SessionStore(root).load(log.meta.projectId, log.meta.id);
	assert.equal(log.compaction?.keptFrom, 6, "运行中保留边界");
	assert.equal(reloaded?.compaction?.keptFrom, 6, "重启后也保留");

	// 截点落在工具结果上会被挪到调用之前：两边都按挪过的位置判断，越过了边界就都废弃。
	await log.emit({ type: "compacted", before: 6, after: 3, kept: 1, summary: "S2" });
	assert.equal(log.compaction?.keptFrom, 5);
	await log.truncateFrom(4);
	assert.equal(log.messages.length, 3);
	assert.equal(log.compaction, null);
	assert.equal((await new SessionStore(root).load(log.meta.projectId, log.meta.id))?.compaction ?? null, null);
});

test("subagent assistant usage survives session reload and rebuildIndex", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ly-store-subagent-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const store = new SessionStore(root);

	let meta = await store.create("/tmp/project", "model");
	const subUsage = {
		...emptyUsage(),
		input: 1000,
		output: 200,
		cacheRead: 800,
		cacheWrite: 100,
		total: 1200,
	};
	const subMsg: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "sub-agent result" }],
		api: "openai-responses",
		provider: "test-provider",
		model: "test-model",
		usage: subUsage,
		stopReason: "stop",
		timestamp: Date.now(),
	};

	meta = await store.append(meta, {
		type: "event",
		event: {
			type: "subagent_message",
			id: "sub-1",
			message: subMsg,
		},
	});

	assert.equal(meta.usage.input, 1000);
	assert.equal(meta.usage.cacheRead, 800);
	assert.equal(meta.usage.total, 1200);

	// Fresh store instance simulating app reload / reopen
	const freshStore = new SessionStore(root);
	const loaded = await freshStore.load(meta.projectId, meta.id);
	assert.ok(loaded);
	assert.equal(loaded.meta.usage.input, 1000, "input usage preserved on reload");
	assert.equal(loaded.meta.usage.cacheRead, 800, "cacheRead usage preserved on reload");
	assert.equal(loaded.meta.usage.total, 1200, "total usage preserved on reload");

	const rebuilt = await freshStore.rebuildIndex();
	const indexedMeta = rebuilt.find((m) => m.id === meta.id);
	assert.ok(indexedMeta);
	assert.equal(indexedMeta.usage.input, 1000, "input usage preserved in index.json");
	assert.equal(indexedMeta.usage.cacheRead, 800, "cacheRead usage preserved in index.json");
	assert.equal(indexedMeta.usage.total, 1200, "total usage preserved in index.json");
});

test("subagent usage is dropped when parent turn is truncated, but auxiliary usage survives", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ly-store-trunc-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const store = new SessionStore(root);

	let meta = await store.create("/tmp/project", "model");

	// 1. Auxiliary usage (e.g. title-summary or side-chat)
	const auxUsage = { ...emptyUsage(), input: 50, output: 10, total: 60 };
	meta = await store.append(meta, {
		type: "usage",
		source: "title-summary",
		providerId: "test",
		modelId: "test-model",
		usage: auxUsage,
	});

	// 2. Turn 1 (persists)
	meta = await store.append(meta, {
		type: "message",
		message: { role: "user", content: [{ type: "text", text: "q1" }], timestamp: 1 },
	});
	meta = await store.append(meta, {
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "a1" }],
			api: "openai-responses",
			provider: "p",
			model: "m",
			usage: { ...emptyUsage(), input: 100, output: 20, total: 120 },
			stopReason: "stop",
			timestamp: 2,
		},
	});

	// 3. Turn 2 (to be truncated, contains sub-agent usage)
	meta = await store.append(meta, {
		type: "message",
		message: { role: "user", content: [{ type: "text", text: "q2" }], timestamp: 3 },
	});
	meta = await store.append(meta, {
		type: "event",
		event: {
			type: "subagent_message",
			id: "sub-2",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "sub answer" }],
				api: "openai-responses",
				provider: "p",
				model: "m",
				usage: { ...emptyUsage(), input: 500, output: 50, total: 550 },
				stopReason: "stop",
				timestamp: 4,
			},
		},
	});
	meta = await store.append(meta, {
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "a2" }],
			api: "openai-responses",
			provider: "p",
			model: "m",
			usage: { ...emptyUsage(), input: 200, output: 30, total: 230 },
			stopReason: "stop",
			timestamp: 5,
		},
	});

	assert.equal(meta.usage.total, 60 + 120 + 550 + 230); // 960

	// Truncate from messageIndex 2 (the second user message)
	const truncated = await store.truncateFrom(meta.projectId, meta.id, 2);
	assert.ok(truncated);
	assert.equal(truncated.messages.length, 2);

	// Expected surviving usage: auxUsage (60) + turn 1 assistant (120) = 180
	assert.equal(truncated.meta.usage.total, 180, "truncated meta in return value has surviving usage");

	const loaded = await store.load(meta.projectId, meta.id);
	assert.ok(loaded);
	assert.equal(loaded.meta.usage.total, 180, "loaded meta has surviving usage");
	assert.equal(loaded.meta.usage.input, 150); // 50 + 100

	const indexed = (await store.listSessions()).find((s) => s.id === meta.id);
	assert.ok(indexed);
	assert.equal(indexed.usage.total, 180, "index.json has surviving usage");
});
