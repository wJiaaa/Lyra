import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { gatherMemory } from "../src/runtime/memory-inject.ts";
import { forgetLesson, readLessons, recordLesson } from "../src/runtime/project-memory.ts";
import { SessionLog } from "../src/runtime/session-log.ts";
import { SessionStore } from "../src/session/store.ts";

let home: string;
let project: string;
before(async () => {
	home = await mkdtemp(join(tmpdir(), "ly-snap-home-"));
	project = await mkdtemp(join(tmpdir(), "ly-snap-proj-"));
	process.env.PLUME_HOME = home;
});
after(async () => {
	delete process.env.PLUME_HOME;
	await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
	await rm(project, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
});

test("learning mid-session leaves the prompt's memory untouched until the session compacts", async () => {
	const store = new SessionStore(join(home, "sessions"));
	const log = new SessionLog(store, () => {}, await store.create(project, "m"));
	const scope = log.meta.id;
	await recordLesson(project, { text: "用 pnpm 不用 npm" });
	const first = await gatherMemory(project, true, 0, true, false, scope);
	assert.match(first.projectMemory, /pnpm/);

	// The learn call and its result are in the history; the system prompt keeps its bytes.
	await recordLesson(project, { text: "测试用 node:test" });
	assert.equal((await gatherMemory(project, true, 0, true, false, scope)).projectMemory, first.projectMemory);
	assert.match((await gatherMemory(project, true, 0, true, false)).projectMemory, /node:test/, "callers without a session read fresh");

	// A summary may have folded the learn call away; the refreshed memory carries it instead.
	await log.emit({ type: "compacted", before: 10, after: 4, kept: 2, summary: "s" });
	const refreshed = await gatherMemory(project, true, 0, true, false, scope);
	assert.match(refreshed.projectMemory, /node:test/);

	// A person deleting a wrong lesson wants it gone now, not after the next compaction.
	const [wrong] = await readLessons(project);
	await forgetLesson(project, wrong.at);
	assert.doesNotMatch((await gatherMemory(project, true, 0, true, false, scope)).projectMemory, /node:test/);
});
