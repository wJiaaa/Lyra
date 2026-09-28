/**
 * Reading blobs in a batch, against a real repository.
 *
 * The claim: one `cat-file --batch` returns exactly what a `git show` per file returned — same
 * bytes, same order, same three answers for the three cases that are not "here it is" (no such
 * object, too large to diff, a path that cannot be framed on stdin).
 *
 * Worth a real repository rather than a stub. The whole risk in this change is the wire format:
 * `--batch` writes a header line, then exactly `size` bytes, then a newline of its own, and every
 * bug available here is an off-by-one in that walk — which a mock of git would faithfully
 * reproduce from the same wrong reading of the docs that produced the bug.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import { readBlobs } from "../electron/git-blobs.ts";
import { MAX_BLOB_BYTES } from "../electron/git-exec.ts";

const exec = promisify(execFile);

let repo: string;

before(async () => {
	repo = await mkdtemp(join(tmpdir(), "plume-blobs-"));
	await exec("git", ["init", "-q"], { cwd: repo });
	await exec("git", ["config", "user.email", "t@example.com"], { cwd: repo });
	await exec("git", ["config", "user.name", "t"], { cwd: repo });

	await writeFile(join(repo, "plain.txt"), "one\ntwo\nthree\n");
	// No trailing newline: the batch format appends one of its own, and a walk that assumes the
	// content ended in a newline would swallow the first byte of the next header.
	await writeFile(join(repo, "no-newline.txt"), "tail");
	await writeFile(join(repo, "empty.txt"), "");
	// A NUL byte and a high byte: the caller decides what is text, so this must survive verbatim.
	await writeFile(join(repo, "binary.bin"), Buffer.from([0x00, 0xff, 0x10, 0x00, 0x41]));
	await writeFile(join(repo, "huge.txt"), "x".repeat(MAX_BLOB_BYTES + 10));
	await exec("git", ["add", "-A"], { cwd: repo });
	await exec("git", ["commit", "-qm", "seed"], { cwd: repo });
});

after(async () => {
	await rm(repo, { recursive: true, force: true });
});

test("a blob comes back byte for byte", async () => {
	const [read] = await readBlobs(repo, ["HEAD:plain.txt"]);
	assert.ok(read?.content);
	assert.equal(read.content.toString("utf8"), "one\ntwo\nthree\n");
	assert.equal(read.bytes, 14);
});

test("content that does not end in a newline is not run into the next entry", async () => {
	const reads = await readBlobs(repo, ["HEAD:no-newline.txt", "HEAD:plain.txt"]);
	assert.equal(reads[0]?.content?.toString("utf8"), "tail");
	assert.equal(reads[1]?.content?.toString("utf8"), "one\ntwo\nthree\n");
});

test("an empty blob is a blob, not an absence", async () => {
	const [read] = await readBlobs(repo, ["HEAD:empty.txt"]);
	assert.ok(read, "an empty file still exists");
	assert.equal(read.bytes, 0);
	assert.equal(read.content?.length, 0);
});

test("bytes are not mangled into text", async () => {
	const [read] = await readBlobs(repo, ["HEAD:binary.bin"]);
	assert.deepEqual([...(read?.content ?? [])], [0x00, 0xff, 0x10, 0x00, 0x41]);
});

test("something too large to diff says so, rather than arriving", async () => {
	const [read] = await readBlobs(repo, ["HEAD:huge.txt"]);
	assert.ok(read, "it exists");
	assert.equal(read.content, null, "and is deliberately not read");
	assert.equal(read.bytes, MAX_BLOB_BYTES + 10, "its size is still known");
});

test("a path git has never heard of is null", async () => {
	const [read] = await readBlobs(repo, ["HEAD:nope.txt"]);
	assert.equal(read, null);
});

test("answers line up with the order asked for, whatever happened to each", async () => {
	const reads = await readBlobs(repo, [
		"HEAD:plain.txt",
		"HEAD:nope.txt",
		"HEAD:huge.txt",
		"HEAD:empty.txt",
		"HEAD:no-newline.txt",
	]);
	assert.equal(reads.length, 5);
	assert.equal(reads[0]?.content?.toString("utf8"), "one\ntwo\nthree\n");
	assert.equal(reads[1], null);
	assert.equal(reads[2]?.content, null);
	assert.equal(reads[3]?.bytes, 0);
	assert.equal(reads[4]?.content?.toString("utf8"), "tail");
});

test("an empty revision is a side that does not exist", async () => {
	// `collectWorkspaceDiff` passes "" for the committed side of an added file rather than
	// branching around the batch, so this has to be a well-defined null.
	const reads = await readBlobs(repo, ["", "HEAD:plain.txt"]);
	assert.equal(reads[0], null);
	assert.equal(reads[1]?.content?.toString("utf8"), "one\ntwo\nthree\n");
});

test("asking for nothing does not run git", async () => {
	assert.deepEqual(await readBlobs(repo, []), []);
});

test("a path with a newline in it cannot be framed, and is refused rather than guessed at", async () => {
	const reads = await readBlobs(repo, ["HEAD:we\nird.txt", "HEAD:plain.txt"]);
	assert.equal(reads[0], null);
	// And it must not have thrown the rest of the batch off by one.
	assert.equal(reads[1]?.content?.toString("utf8"), "one\ntwo\nthree\n");
});

test("the batch matches what git show would have said, file by file", async () => {
	const paths = ["plain.txt", "no-newline.txt", "empty.txt", "binary.bin"];
	const batched = await readBlobs(repo, paths.map((p) => `HEAD:${p}`));
	for (const [i, path] of paths.entries()) {
		const { stdout } = await exec("git", ["show", `HEAD:${path}`], { cwd: repo, encoding: "buffer" });
		assert.deepEqual(batched[i]?.content, stdout, path);
	}
});
