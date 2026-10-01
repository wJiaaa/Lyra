import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/session/store.ts";
import { SessionLog } from "../src/runtime/session-log.ts";
import type { AgentEvent, CommandRun } from "../src/agent/events.ts";

const command: CommandRun = { id: "compact-1", name: "compact", input: "/compact", timestamp: 1, at: 0, status: "running", detail: "正在压缩会话…" };
const boundary: Extract<AgentEvent, { type: "compacted" }> = { type: "compacted", before: 12, after: 4, summary: "committed", kept: 2 };

test("a rejected boundary append leaves the previous in-memory and durable view intact", async () => {
	const root = await mkdtemp(join(tmpdir(), "ly-compact-recovery-"));
	try {
		const store = new SessionStore(root);
		const meta = await store.create(root, "model");
		let fail = false;
		const append = store.append.bind(store);
		store.append = async (meta, record) => {
			if (fail && record.type === "event" && record.event.type === "compacted") throw new Error("disk full");
			return append(meta, record);
		};
		const log = new SessionLog(store, () => {}, meta);
		await log.emit(boundary);
		assert.equal(log.compaction?.summary, "committed");
		const previous = log.compaction;
		fail = true;
		await assert.rejects(log.emit({ ...boundary, summary: "not written" }), /disk full/);
		assert.deepEqual(log.compaction, previous);
		assert.equal(log.compactions.length, 1);
		assert.equal((await store.load(meta.id))?.compaction?.summary, "committed");
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("restart reconciles a committed manual boundary even when completion was not written", async () => {
	const root = await mkdtemp(join(tmpdir(), "ly-compact-recovery-"));
	try {
		const store = new SessionStore(root);
		let meta = await store.create(root, "model");
		meta = await store.append(meta, { type: "event", event: { type: "command_status", command } });
		meta = await store.append(meta, { type: "event", event: { ...boundary, commandId: command.id } });
		const loaded = await new SessionStore(root).load(meta.id);
		assert.equal(loaded?.commandRuns?.[0].status, "done");
		assert.equal(loaded?.compaction?.summary, "committed");
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("an uncommitted or unrelated operation stays interrupted and preserves the previous boundary", async () => {
	const root = await mkdtemp(join(tmpdir(), "ly-compact-recovery-"));
	try {
		const store = new SessionStore(root);
		let meta = await store.create(root, "model");
		meta = await store.append(meta, { type: "event", event: boundary });
		meta = await store.append(meta, { type: "event", event: { type: "command_status", command } });
		meta = await store.append(meta, { type: "event", event: { ...boundary, commandId: "other-command" } });
		const loaded = await store.load(meta.id);
		assert.equal(loaded?.commandRuns?.[0].status, "cancelled");
		assert.equal(loaded?.compaction?.summary, "committed");
		assert.equal(loaded?.meta.seq, meta.seq, "restoring does not retry or append anything");
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("a committed boundary survives event delivery failure and completes only its own command", async () => {
	const root = await mkdtemp(join(tmpdir(), "ly-compact-recovery-"));
	try {
		const store = new SessionStore(root);
		const meta = await store.create(root, "model");
		const log = new SessionLog(store, (event) => { if (event.type === "compacted") throw new Error("window closed"); }, meta);
		await log.emit({ type: "command_status", command });
		await assert.rejects(log.emit({ ...boundary, commandId: command.id }), /window closed/);
		assert.equal(log.compaction?.summary, "committed");
		assert.equal(log.commandRuns[0].status, "done");
		assert.equal((await store.load(meta.id))?.commandRuns?.[0].status, "done");
	} finally { await rm(root, { recursive: true, force: true }); }
});
