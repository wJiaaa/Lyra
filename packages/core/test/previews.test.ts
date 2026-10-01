import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	listPreviews,
	previewsHome,
	prunePreviews,
	pruneSessionArtifacts,
	readPreview,
	removePreviews,
	removeSessionArtifacts,
	scratchHome,
	writePreview,
} from "../src/runtime/previews.ts";

async function sandbox(t: { after: (fn: () => unknown) => void }): Promise<string> {
	const home = await mkdtemp(join(tmpdir(), "ly-previews-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	return home;
}

const page = (body: string) => ({ path: "index.html", content: `<!doctype html><body>${body}</body>` });

test("a preview is written under its own session and id, never the workspace", async (t) => {
	const home = await sandbox(t);
	const record = await writePreview(home, {
		id: "snake",
		sessionId: "sess-1",
		title: "贪吃蛇",
		files: [page("game"), { path: "game.js", content: "// tick" }],
	});

	assert.equal(record.dir, join(previewsHome(home), "sess-1", "snake"));
	assert.equal(record.entry, "index.html");
	assert.match(await readFile(join(record.dir, "index.html"), "utf8"), /game/);
	assert.equal(await readFile(join(record.dir, "game.js"), "utf8"), "// tick");
});

test("nested paths are kept, so a preview can have its own folders", async (t) => {
	const home = await sandbox(t);
	const record = await writePreview(home, {
		id: "p",
		sessionId: "s",
		title: "t",
		files: [page("x"), { path: "assets/style.css", content: "body{color:red}" }],
	});
	assert.equal(await readFile(join(record.dir, "assets/style.css"), "utf8"), "body{color:red}");
});

test("paths that climb out of the preview directory are dropped, not written", async (t) => {
	const home = await sandbox(t);
	const outside = join(home, "escaped.txt");
	const record = await writePreview(home, {
		id: "p",
		sessionId: "s",
		title: "t",
		files: [
			page("safe"),
			{ path: "../../../escaped.txt", content: "owned" },
			{ path: "/etc/passwd", content: "owned" },
			{ path: "~/.ssh/authorized_keys", content: "owned" },
			{ path: "a/../../b.txt", content: "owned" },
		],
	});

	await assert.rejects(stat(outside), "the parent directory must be untouched");
	// The one legitimate file still landed; a bad sibling does not fail the whole write.
	assert.match(await readFile(join(record.dir, "index.html"), "utf8"), /safe/);
});

test("an entry that escapes falls back to index.html", async (t) => {
	const home = await sandbox(t);
	const record = await writePreview(home, {
		id: "p",
		sessionId: "s",
		title: "t",
		entry: "../../../../etc/hosts",
		files: [page("x")],
	});
	assert.equal(record.entry, "index.html");
});

test("a write with nothing writable fails rather than leaving an empty preview", async (t) => {
	const home = await sandbox(t);
	await assert.rejects(
		writePreview(home, { id: "p", sessionId: "s", title: "t", files: [{ path: "../x", content: "n" }] }),
		/没有可写入的文件/,
	);
});

test("previews are read back with their metadata and listed newest first", async (t) => {
	const home = await sandbox(t);
	const first = await writePreview(home, { id: "a", sessionId: "s", title: "先", files: [page("a")] });
	// createdAt comes from the clock, so force the ordering rather than racing it.
	await writeFile(join(first.dir, ".preview.json"), JSON.stringify({ ...first, createdAt: 1 }), "utf8");
	await writePreview(home, { id: "b", sessionId: "s", title: "后", files: [page("b")] });

	const read = await readPreview(home, "s", "a");
	assert.equal(read?.title, "先");
	assert.deepEqual((await listPreviews(home, "s")).map((p) => p.id), ["b", "a"]);
	assert.equal(await readPreview(home, "s", "missing"), null);
	assert.deepEqual(await listPreviews(home, "no-such-session"), []);
});

test("deleting a conversation takes its previews and leaves other conversations alone", async (t) => {
	const home = await sandbox(t);
	await writePreview(home, { id: "p", sessionId: "doomed", title: "t", files: [page("x")] });
	const keeper = await writePreview(home, { id: "p", sessionId: "kept", title: "t", files: [page("x")] });

	await removePreviews(home, "doomed");
	assert.deepEqual(await listPreviews(home, "doomed"), []);
	assert.equal((await listPreviews(home, "kept")).length, 1);
	assert.ok(await stat(keeper.dir));
	// Removing a session that never had previews is a no-op, not a throw.
	await removePreviews(home, "never-existed");
});

test("pruning drops previews of dead sessions and of live ones past the age limit", async (t) => {
	const home = await sandbox(t);
	await writePreview(home, { id: "p", sessionId: "live", title: "t", files: [page("x")] });
	await writePreview(home, { id: "p", sessionId: "dead", title: "t", files: [page("x")] });
	const stale = await writePreview(home, { id: "p", sessionId: "stale", title: "t", files: [page("x")] });

	const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
	await utimes(join(previewsHome(home), "stale"), old, old);

	const removed = await prunePreviews(home, new Set(["live", "stale"]));
	assert.equal(removed, 2, "the dead session and the stale one");
	assert.equal((await listPreviews(home, "live")).length, 1);
	assert.deepEqual(await listPreviews(home, "dead"), []);
	await assert.rejects(stat(stale.dir));
});

test("pruning an empty or missing previews directory is harmless", async (t) => {
	const home = await sandbox(t);
	assert.equal(await prunePreviews(home, new Set(["anything"])), 0);
});

/** The model is told to write throwaway files here; nothing else creates it. */
async function scratch(home: string, sessionId: string, name = "notes.txt"): Promise<string> {
	const dir = join(scratchHome(home), sessionId);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, name), "temp", "utf8");
	return dir;
}

test("deleting a conversation takes its scratch files as well as its previews", async (t) => {
	const home = await sandbox(t);
	await writePreview(home, { id: "p", sessionId: "doomed", title: "t", files: [page("x")] });
	const doomed = await scratch(home, "doomed");
	const kept = await scratch(home, "kept");

	await removeSessionArtifacts(home, "doomed");
	await assert.rejects(stat(doomed), "the scratch directory must go with the conversation");
	assert.deepEqual(await listPreviews(home, "doomed"), []);
	assert.ok(await stat(kept), "another conversation's scratch files are untouched");
});

test("pruning covers scratch directories, not just previews", async (t) => {
	const home = await sandbox(t);
	await writePreview(home, { id: "p", sessionId: "dead", title: "t", files: [page("x")] });
	const deadScratch = await scratch(home, "dead");
	const liveScratch = await scratch(home, "live");

	// One preview directory and one scratch directory, both belonging to the same dead session.
	assert.equal(await pruneSessionArtifacts(home, new Set(["live"])), 2);
	await assert.rejects(stat(deadScratch));
	assert.ok(await stat(liveScratch));
});

test("a session id that would climb out of its directory deletes nothing", async (t) => {
	const home = await sandbox(t);
	// `home` stands in for the app's directory; the id arrives over IPC and the web bridge.
	const outside = join(home, "outside.txt");
	await writeFile(outside, "the user's file");
	const kept = await scratch(home, "kept");
	for (const id of ["..", ".", "", "../outside.txt", "kept/..", "a\\..\\.."]) {
		await assert.rejects(removeSessionArtifacts(join(home, "app"), id), /Invalid session id/);
		await assert.rejects(removePreviews(join(home, "app"), id), /Invalid session id/);
	}
	await assert.rejects(removeSessionArtifacts(home, ".."), /Invalid session id/);
	assert.equal(await readFile(outside, "utf8"), "the user's file");
	assert.ok(await stat(kept));
});
