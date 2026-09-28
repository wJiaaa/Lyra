import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionStore } from "@plume/core";
import { observeSessionStorage } from "../electron/session-storage.ts";
import type { SessionChange } from "../electron/ipc-shapes.ts";
import { readTrajectoryChanges } from "../electron/trajectory-changes.ts";

test("committed cold-session changes notify every persistence path without broadcasting tokens", async () => {
	const root = await mkdtemp(join(tmpdir(), "plume-session-sync-"));
	const changes: SessionChange[] = [];
	const store = observeSessionStorage(new SessionStore(join(root, "sessions")), (change) => changes.push(change));
	try {
		let meta = await store.create(root, "model-a");
		assert.equal(changes.length, 1);
		meta = await store.append(meta, { type: "title", title: "Phone title" });
		assert.equal(changes.at(-1)?.meta?.title, "Phone title");
		meta = await store.append(meta, { type: "meta", meta: { ...meta, modelId: "model-b", thinking: "high" } });
		assert.equal(changes.at(-1)?.meta?.modelId, "model-b");
		assert.equal(changes.at(-1)?.meta?.thinking, "high");
		await store.setArchived(meta.projectId, meta.id, true);
		assert.equal(changes.at(-1)?.meta?.archived, true);
		await store.setArchived(meta.projectId, meta.id, false);
		assert.equal(changes.at(-1)?.meta?.archived, false);
		const before = changes.length;
		await store.append(meta, { type: "event", event: { type: "agent_start" } });
		assert.equal(changes.length, before, "agent stream has its own channel");
		await store.delete(meta.projectId, meta.id);
		assert.deepEqual(changes.at(-1), { id: meta.id, projectId: meta.projectId, meta: null });
		assert.deepEqual(await store.listSessions(), []);
		const a = await store.create(root, "model-a"), b = await store.create(root, "model-a");
		await store.deleteMany([a, b]);
		assert.deepEqual(changes.slice(-2).map((change) => [change.id, change.meta]), [[a.id, null], [b.id, null]]);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("failed persistence never claims a successful change", async () => {
	const source = new SessionStore();
	source.delete = async () => { throw new Error("disk unavailable"); };
	const changes: SessionChange[] = [];
	const store = observeSessionStorage(source, (change) => changes.push(change));
	await assert.rejects(store.delete("project", "session"), /disk unavailable/);
	assert.deepEqual(changes, []);
});

test("the desktop observer preserves incremental log reads through the real trajectory service", async () => {
	const root = await mkdtemp(join(tmpdir(), "plume-observed-trajectory-"));
	const source = new SessionStore(root);
	let fullReads = 0;
	const read = source.read.bind(source);
	source.read = async function* (...args) { fullReads++; yield* read(...args); };
	const store = observeSessionStorage(source, () => {});
	try {
		const meta = await store.create(root, "model");
		await store.append(meta, { type: "message", message: { role: "user", content: [{ type: "text", text: "A large persisted body" }], timestamp: 1 } });
		const baselineReads = fullReads;
		const first = await readTrajectoryChanges(store, meta.projectId, meta.id);
		const unchanged = await readTrajectoryChanges(store, meta.projectId, meta.id, first.cursor);
		assert.equal(unchanged.reset, false);
		assert.deepEqual(unchanged.upserts, []);
		await store.append(meta, { type: "event", event: { type: "notice", level: "info", message: "appended" } });
		const next = await readTrajectoryChanges(store, meta.projectId, meta.id, first.cursor);
		assert.equal(next.upserts.length, 1);
		assert.equal(next.upserts[0].detail, "appended");
		assert.equal(fullReads, baselineReads, "wrapping the store must not silently restore full-file scans");
	} finally { await rm(root, { recursive: true, force: true }); }
});
