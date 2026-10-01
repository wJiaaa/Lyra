import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionStore } from "../src/session/store.ts";

test("a manual title atomically rejects automatic writes and stale metadata from another session instance", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ly-title-order-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const store = new SessionStore(root);
	const stale = await store.create(root, "model", "Initial");
	const manual = store.append(stale, { type: "title", title: "Manual", source: "user" });
	const automatic = store.append(stale, { type: "title", title: "Late automatic", source: "auto" });
	await Promise.all([manual, automatic]);
	await store.append(stale, { type: "meta", meta: { ...stale, modelId: "another-model" } });
	const loaded = await new SessionStore(root).load(stale.id);
	assert.equal(loaded?.meta.title, "Manual");
	assert.equal(loaded?.meta.titleSetByUser, true);
	assert.equal(loaded?.meta.modelId, "another-model");
	assert.equal((await store.listSessions())[0].title, "Manual");
});
