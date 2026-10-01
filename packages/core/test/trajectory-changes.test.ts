import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionStore } from "../src/session/store.ts";
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
	return { root, store, meta, reader, cleanup: () => { store.close(); return rm(root, { recursive: true, force: true }); } };
}

test("unchanged refreshes read no records and transfer no repeated trajectory bodies", async () => {
	const f = await fixture();
	try {
		await f.store.append(f.meta, { type: "message", message: { role: "user", timestamp: 1, content: [{ type: "text", text: "large output ".repeat(10000) }] } });
		const first = await f.reader.changes(f.meta.id);
		assert.equal(first.reset, true);
		assert.deepEqual(first.upserts, await readTrajectory(f.store, f.meta.id));
		const second = await f.reader.changes(f.meta.id, first.cursor);
		assert.deepEqual(second, { cursor: first.cursor, reset: false, upserts: [], removals: [] });
	} finally { await f.cleanup(); }
});

test("tool completion updates its existing call and remains replayable for concurrent subscribers", async () => {
	const f = await fixture();
	try {
		await f.store.append(f.meta, { type: "event", event: { type: "tool_start", toolCallId: "call", toolName: "bash", args: { command: "pwd" }, summary: "pwd" } });
		const first = await f.reader.changes(f.meta.id, undefined, true);
		await f.store.append(f.meta, { type: "message", message: { role: "toolResult", toolCallId: "call", toolName: "bash", timestamp: 2, isError: false, content: [{ type: "text", text: "result body" }] } });
		const [desktop, phone] = await Promise.all([
			f.reader.changes(f.meta.id, first.cursor, true),
			f.reader.changes(f.meta.id, first.cursor, true),
		]);
		assert.deepEqual(desktop, phone);
		assert.equal(desktop.reset, false);
		assert.equal(desktop.upserts.length, 2);
		assert.equal(desktop.upserts[0].id, first.upserts[0].id);
		assert.equal(first.upserts[0].status, "running", "published entries must remain immutable");
		assert.deepEqual(apply(first.upserts, desktop), await readTrajectory(f.store, f.meta.id, true));
	} finally { await f.cleanup(); }
});

test("runtime state changes update unfinished entries even without another persisted record", async () => {
	const f = await fixture();
	try {
		await f.store.append(f.meta, { type: "event", event: { type: "request", provider: "test", model: "model", messageCount: 1 } });
		const cold = await f.reader.changes(f.meta.id);
		assert.equal(cold.upserts[0].status, "interrupted");
		const live = await f.reader.changes(f.meta.id, cold.cursor, true);
		assert.equal(live.upserts[0].status, "running");
		const stopped = await f.reader.changes(f.meta.id, live.cursor);
		assert.equal(stopped.upserts[0].status, "interrupted");
	} finally { await f.cleanup(); }
});

test("rewinding removes discarded results and restores the surviving call's uncompleted state", async () => {
	const f = await fixture();
	try {
		const call = await f.store.append(f.meta, { type: "event", event: { type: "tool_start", toolCallId: "call", toolName: "bash", args: {}, summary: "run" } });
		await f.store.append(f.meta, { type: "message", message: { role: "toolResult", toolCallId: "call", toolName: "bash", timestamp: 2, isError: false, content: [{ type: "text", text: "discard me" }] } });
		const first = await f.reader.changes(f.meta.id, undefined, true);
		await f.store.append(f.meta, { type: "truncate", afterSeq: call.seq });
		const rewind = await f.reader.changes(f.meta.id, first.cursor, true);
		assert.equal(rewind.reset, false);
		assert.equal(rewind.removals.length, 1);
		assert.equal(rewind.upserts[0].output, undefined);
		assert.equal(rewind.upserts[0].status, "running");
		assert.deepEqual(apply(first.upserts, rewind), await readTrajectory(f.store, f.meta.id, true));
		await f.store.append(f.meta, { type: "message", message: { role: "user", timestamp: 3, content: [{ type: "text", text: "resume" }] } });
		const resumed = await f.reader.changes(f.meta.id, first.cursor, true);
		assert.deepEqual(apply(first.upserts, resumed), await readTrajectory(f.store, f.meta.id, true));
	} finally { await f.cleanup(); }
});

test("a retired cache epoch resets stale client cursors", async () => {
	const f = await fixture();
	try {
		await f.store.append(f.meta, { type: "message", message: { role: "user", timestamp: 1, content: [{ type: "text", text: "before" }] } });
		const bounded = new TrajectoryReader(f.store, 1);
		const cached = await bounded.changes(f.meta.id);
		const other = await f.store.create(f.root, "test/model");
		await bounded.changes(other.id);
		assert.equal((await bounded.changes(f.meta.id, cached.cursor)).reset, true);
	} finally { await f.cleanup(); }
});
