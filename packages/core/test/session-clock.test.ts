/**
 * One session, one `updatedAt` — whichever copy is asked.
 *
 * A new session once took the time twice: the meta record said T0, the list said T1, and moving or
 * archiving — which must keep `updatedAt` as it was — kept whichever one was read last. Only when
 * the two calls straddled a millisecond, which is why `session-move.test.ts` failed now and then.
 *
 * A clock that moves one millisecond per call makes every straddle happen, every time.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { SessionStore, type SessionMeta } from "../src/session/store.ts";

function tickingClock(t: TestContext): void {
	let now = Date.now();
	t.mock.method(Date, "now", () => (now += 1));
}

async function withStore(run: (store: SessionStore, root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "plume-clock-"));
	const store = new SessionStore(root);
	try {
		await run(store, root);
	} finally {
		store.close();
		await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
	}
}

test("the list, the meta record and a restarted app agree on when a session was made", async (t) => {
	tickingClock(t);
	await withStore(async (store, root) => {
		const created = await store.create("/tmp/project-a", "fake/model");
		const listed = (await new SessionStore(root).listSessions()).find((s) => s.id === created.id);
		let recorded: SessionMeta | undefined;
		for await (const record of store.read(created.id)) if (record.type === "meta") recorded = record.meta;

		assert.equal(listed?.updatedAt, created.updatedAt);
		assert.equal(recorded?.updatedAt, created.updatedAt);
		assert.equal(created.createdAt, created.updatedAt);
	});
});

test("moving a session keeps its place in the list", async (t) => {
	tickingClock(t);
	await withStore(async (store) => {
		const created = await store.create("/tmp/project-a", "fake/model");
		const before = (await store.listSessions()).find((s) => s.id === created.id)!.updatedAt;

		const moved = await store.move(created.id, "/tmp/project-b", "B 项目");
		const after = (await store.listSessions()).find((s) => s.id === created.id)!.updatedAt;

		assert.equal(moved?.updatedAt, before);
		assert.equal(after, before, "filing a session away moved it in the list");
	});
});
