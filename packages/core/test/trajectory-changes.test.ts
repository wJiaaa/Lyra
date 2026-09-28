import assert from "node:assert/strict";
import { appendFile, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionStore } from "../src/session/store.ts";
import { readRecordChanges } from "../src/session/read-changes.ts";
import { TrajectoryReader } from "../src/trajectory/changes.ts";
import { readTrajectory } from "../src/trajectory/read.ts";
import { entryKey, type Entry, type TrajectoryChanges } from "../src/trajectory/types.ts";

function apply(entries: Entry[], changes: TrajectoryChanges): Entry[] {
	const next = new Map((changes.reset ? [] : entries).map(entry => [entryKey(entry), entry]));
	for (const id of changes.removals) next.delete(id);
	for (const entry of changes.upserts) next.set(entryKey(entry), entry);
	return [...next.values()];
}

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "plume-trajectory-changes-"));
	const store = new SessionStore(root);
	const meta = await store.create(root, "test/model");
	const reader = new TrajectoryReader(store);
	return { root, store, meta, reader, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("unchanged refreshes read no records and transfer no repeated trajectory bodies", async () => {
	const f = await fixture();
	try {
		await f.store.append(f.meta, { type: "message", message: { role: "user", timestamp: 1, content: [{ type: "text", text: "large output ".repeat(10000) }] } });
		const first = await f.reader.changes(f.meta.projectId, f.meta.id);
		assert.equal(first.reset, true);
		assert.deepEqual(first.upserts, await readTrajectory(f.store, f.meta.projectId, f.meta.id));
		const second = await f.reader.changes(f.meta.projectId, f.meta.id, first.cursor);
		assert.deepEqual(second, { cursor: first.cursor, reset: false, upserts: [], removals: [] });
		const before = await f.store.readChanges(f.meta.projectId, f.meta.id);
		const after = await f.store.readChanges(f.meta.projectId, f.meta.id, before.cursor);
		assert.equal(after.records.length, 0);
		assert.equal(after.cursor.offset, before.cursor.offset);
	} finally { await f.cleanup(); }
});

test("tool completion updates its existing call and remains replayable for concurrent subscribers", async () => {
	const f = await fixture();
	try {
		await f.store.append(f.meta, { type: "event", event: { type: "tool_start", toolCallId: "call", toolName: "bash", args: { command: "pwd" }, summary: "pwd" } });
		const first = await f.reader.changes(f.meta.projectId, f.meta.id, undefined, true);
		const bytes = await f.store.readChanges(f.meta.projectId, f.meta.id);
		await f.store.append(f.meta, { type: "message", message: { role: "toolResult", toolCallId: "call", toolName: "bash", timestamp: 2, isError: false, content: [{ type: "text", text: "result body" }] } });
		const tail = await f.store.readChanges(f.meta.projectId, f.meta.id, bytes.cursor);
		assert.equal(tail.reset, false);
		assert.equal(tail.records.length, 1);
		assert.ok(tail.cursor.offset > bytes.cursor.offset);
		const [desktop, phone] = await Promise.all([
			f.reader.changes(f.meta.projectId, f.meta.id, first.cursor, true),
			f.reader.changes(f.meta.projectId, f.meta.id, first.cursor, true),
		]);
		assert.deepEqual(desktop, phone);
		assert.equal(desktop.reset, false);
		assert.equal(desktop.upserts.length, 2);
		assert.equal(desktop.upserts[0].id, first.upserts[0].id);
		assert.equal(first.upserts[0].status, "running", "published entries must remain immutable");
		assert.deepEqual(apply(first.upserts, desktop), await readTrajectory(f.store, f.meta.projectId, f.meta.id, true));
	} finally { await f.cleanup(); }
});

test("runtime state changes update unfinished entries even without another persisted record", async () => {
	const f = await fixture();
	try {
		await f.store.append(f.meta, { type: "event", event: { type: "request", provider: "test", model: "model", messageCount: 1 } });
		const cold = await f.reader.changes(f.meta.projectId, f.meta.id);
		assert.equal(cold.upserts[0].status, "interrupted");
		const live = await f.reader.changes(f.meta.projectId, f.meta.id, cold.cursor, true);
		assert.equal(live.upserts[0].status, "running");
		const stopped = await f.reader.changes(f.meta.projectId, f.meta.id, live.cursor);
		assert.equal(stopped.upserts[0].status, "interrupted");
	} finally { await f.cleanup(); }
});

test("rewinding removes discarded results and restores the surviving call's uncompleted state", async () => {
	const f = await fixture();
	try {
		const call = await f.store.append(f.meta, { type: "event", event: { type: "tool_start", toolCallId: "call", toolName: "bash", args: {}, summary: "run" } });
		await f.store.append(f.meta, { type: "message", message: { role: "toolResult", toolCallId: "call", toolName: "bash", timestamp: 2, isError: false, content: [{ type: "text", text: "discard me" }] } });
		const first = await f.reader.changes(f.meta.projectId, f.meta.id, undefined, true);
		await f.store.append(f.meta, { type: "truncate", afterSeq: call.seq });
		const rewind = await f.reader.changes(f.meta.projectId, f.meta.id, first.cursor, true);
		assert.equal(rewind.reset, false);
		assert.equal(rewind.removals.length, 1);
		assert.equal(rewind.upserts[0].output, undefined);
		assert.equal(rewind.upserts[0].status, "running");
		assert.deepEqual(apply(first.upserts, rewind), await readTrajectory(f.store, f.meta.projectId, f.meta.id, true));
		await f.store.append(f.meta, { type: "message", message: { role: "user", timestamp: 3, content: [{ type: "text", text: "resume" }] } });
		const resumed = await f.reader.changes(f.meta.projectId, f.meta.id, first.cursor, true);
		assert.deepEqual(apply(first.upserts, resumed), await readTrajectory(f.store, f.meta.projectId, f.meta.id, true));
	} finally { await f.cleanup(); }
});

test("a restored file or retired cache epoch resets stale client cursors", async () => {
	const f = await fixture();
	try {
		await f.store.append(f.meta, { type: "message", message: { role: "user", timestamp: 1, content: [{ type: "text", text: "before" }] } });
		const first = await f.reader.changes(f.meta.projectId, f.meta.id);
		const file = join(f.root, f.meta.projectId, `${f.meta.id}.jsonl`);
		await writeFile(`${file}.restored`, `${JSON.stringify({ seq: 1, ts: 2, type: "message", message: { role: "user", timestamp: 2, content: [{ type: "text", text: "restored" }] } })}\n`);
		await rename(`${file}.restored`, file);
		const restored = await f.reader.changes(f.meta.projectId, f.meta.id, first.cursor);
		assert.equal(restored.reset, true);
		assert.equal(restored.upserts[0].detail, "restored");
		const bounded = new TrajectoryReader(f.store, 1);
		const cached = await bounded.changes(f.meta.projectId, f.meta.id);
		const other = await f.store.create(f.root, "test/model");
		await bounded.changes(other.projectId, other.id);
		assert.equal((await bounded.changes(f.meta.projectId, f.meta.id, cached.cursor)).reset, true);
		await rm(file);
		const deleted = await f.reader.changes(f.meta.projectId, f.meta.id, restored.cursor);
		assert.equal(deleted.reset, true);
		assert.deepEqual(deleted.upserts, []);
	} finally { await f.cleanup(); }
});

test("byte cursors retain incomplete UTF-8 JSONL tails until their terminating newline", async () => {
	const root = await mkdtemp(join(tmpdir(), "plume-record-changes-"));
	try {
		const file = join(root, "records.jsonl");
		const first = `${JSON.stringify({ seq: 1, ts: 1, type: "title", title: "第一行" })}\n`;
		const second = `${JSON.stringify({ seq: 2, ts: 2, type: "title", title: "恢复 🐈" })}\n`;
		const bytes = Buffer.from(second);
		await writeFile(file, Buffer.concat([Buffer.from(first), bytes.subarray(0, bytes.length - 4)]));
		const initial = await readRecordChanges(file);
		assert.equal(initial.records.length, 1);
		assert.equal(initial.cursor.offset, Buffer.byteLength(first));
		await appendFile(file, bytes.subarray(bytes.length - 4));
		const completed = await readRecordChanges(file, initial.cursor);
		assert.equal(completed.reset, false);
		assert.deepEqual(completed.records, [JSON.parse(second)]);
		assert.equal(completed.cursor.offset, Buffer.byteLength(first + second));
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("complete legacy records without a final newline match the full reader and are not repeated", async () => {
	const f = await fixture();
	try {
		const file = join(f.root, f.meta.projectId, `${f.meta.id}.jsonl`);
		await writeFile(file, JSON.stringify({ seq: 1, ts: 1, type: "message", message: { role: "user", timestamp: 1, content: [{ type: "text", text: "legacy" }] } }));
		const first = await f.reader.changes(f.meta.projectId, f.meta.id);
		assert.deepEqual(first.upserts, await readTrajectory(f.store, f.meta.projectId, f.meta.id));
		await appendFile(file, "\n");
		const second = await f.reader.changes(f.meta.projectId, f.meta.id, first.cursor);
		assert.deepEqual(second.upserts, []);
	} finally { await f.cleanup(); }
});
