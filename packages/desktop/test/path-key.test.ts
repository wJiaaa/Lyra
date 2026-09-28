/**
 * One spelling for a path.
 *
 * The bug this exists for was not a wrong answer on screen — it was a comparison that silently
 * never matched, in the guard that stops the worktree cleanup from deleting the checkout a live
 * session is running in. Every case here is a pair of strings that name the same directory and
 * that a plain `===` calls different.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { pathKey, samePath } from "../electron/path-key.ts";

const made: string[] = [];
after(async () => {
	for (const dir of made) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

test("a `..` segment does not make it a different directory", () => {
	// Written out rather than joined: `join` would normalise it away and there would be nothing
	// left to test.
	assert.ok(samePath("/tmp/a/b", "/tmp/a/x/../b"));
});

test("nor does a trailing slash", () => {
	assert.ok(samePath("/tmp/a/b", "/tmp/a/b/"));
});

test("a relative path resolves against the working directory", () => {
	assert.equal(pathKey("."), pathKey(process.cwd()));
});

test("two genuinely different directories stay different", () => {
	assert.ok(!samePath("/tmp/a/b", "/tmp/a/c"));
	assert.ok(!samePath("/tmp/a/b", "/tmp/a/bb"), "a prefix is not a match");
});

test("a path that does not exist still gets a stable answer", () => {
	// `realpath` cannot help here, and the fallback has to be deterministic rather than throwing —
	// a worktree being cleaned up may already be half gone.
	const gone = "/definitely/not/here/at/all";
	assert.equal(pathKey(gone), pathKey(`${gone}/`));
	assert.ok(!samePath(gone, "/definitely/not/here"));
});

test("a real directory reached by going down and back up is the same directory", async () => {
	const dir = await mkdtemp(join(tmpdir(), "plume-pathkey-"));
	made.push(dir);
	const child = await mkdtemp(join(dir, "child-"));

	// Written out so the `..` survives to be resolved. On macOS this also covers the symlink that
	// `os.tmpdir()` hands back — `/var/folders/…` is really `/private/var/folders/…`, and only
	// `realpath` makes the two agree.
	const roundTrip = `${child}/..`;
	assert.notEqual(roundTrip, dir);
	assert.ok(samePath(roundTrip, dir), `${pathKey(roundTrip)} !== ${pathKey(dir)}`);
});

test("the key is idempotent", () => {
	const once = pathKey("/tmp/a/b/../c");
	assert.equal(pathKey(once), once);
});
