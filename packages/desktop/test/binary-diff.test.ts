/**
 * What the review panel does with a file that is not text.
 *
 * Against a real repository, because the bug lived in the seam between git and the reader: one
 * side was read as bytes and the other as a string, and no test that stubbed either would have
 * noticed. A PNG committed, changed, added and deleted is the whole of it.
 *
 * What used to happen: adding or editing an image dropped it from the review entirely — the
 * working-tree read returned null for anything with a NUL byte and the loop skipped the file —
 * while deleting one diffed the committed bytes as text, producing five lines of PNG header,
 * counted as five deletions and added to the totals under the composer.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { collectWorkspaceDiff, previewType, readDiffBlob } from "../electron/git-diff.ts";

const trayDir = join(dirname(fileURLToPath(import.meta.url)), "..", "build", "tray");
const png = (name: string) => readFileSync(join(trayDir, name));

let repo: string;

before(() => {
	repo = mkdtempSync(join(tmpdir(), "plume-bindiff-"));
	const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
	git("init", "-q");
	git("config", "user.email", "test@example.com");
	git("config", "user.name", "test");

	writeFileSync(join(repo, "kept.png"), png("tray@2x.png"));
	writeFileSync(join(repo, "doomed.png"), png("tray.png"));
	writeFileSync(join(repo, "code.ts"), "const a = 1;\n");
	git("add", "-A");
	git("commit", "-qm", "init");

	// One of each kind of change, so every branch of the reader is exercised at once.
	writeFileSync(join(repo, "added.png"), png("trayTemplate@2x.png"));
	writeFileSync(join(repo, "kept.png"), png("tray@1.5x.png"));
	writeFileSync(join(repo, "archive.zip"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]));
	rmSync(join(repo, "doomed.png"));
	writeFileSync(join(repo, "code.ts"), "const a = 1;\nconst b = 2;\n");
	git("add", "-A");
});

after(() => {
	rmSync(repo, { recursive: true, force: true });
});

const byPath = async () => {
	const diff = await collectWorkspaceDiff(repo);
	return { diff, files: new Map(diff.files.map((file) => [file.path, file])) };
};

test("a changed image is listed, not silently dropped from the review", async () => {
	const { files } = await byPath();
	for (const path of ["added.png", "kept.png", "doomed.png"]) {
		assert.ok(files.has(path), `${path} 没有出现在改动列表里`);
	}
	assert.equal(files.get("added.png")?.status, "added");
	assert.equal(files.get("kept.png")?.status, "modified");
	assert.equal(files.get("doomed.png")?.status, "deleted");
});

test("it is marked binary and carries no hunks to render", async () => {
	const { files } = await byPath();
	for (const path of ["added.png", "kept.png", "doomed.png", "archive.zip"]) {
		const file = files.get(path);
		assert.equal(file?.binary, true, `${path} 没有被标成二进制`);
		assert.equal(file?.hunks.length, 0, `${path} 仍然带着按行的 hunk`);
	}
});

test("a deleted image counts as no lines at all — its bytes are not a diff", async () => {
	const { diff, files } = await byPath();
	assert.equal(files.get("doomed.png")?.removed, 0, "PNG 的字节被当成了删掉的行");
	assert.equal(files.get("kept.png")?.added, 0);
	// The text file is the only thing in the totals.
	assert.equal(diff.added, 1);
	assert.equal(diff.removed, 0);
});

test("text files are untouched by any of this", async () => {
	const { files } = await byPath();
	const code = files.get("code.ts");
	assert.equal(code?.binary, undefined);
	assert.equal(code?.added, 1);
	assert.ok((code?.hunks.length ?? 0) > 0);
});

test("a binary file says how big it is, so the row has something concrete to show", async () => {
	const { files } = await byPath();
	assert.ok((files.get("added.png")?.bytes ?? 0) > 0);
	assert.ok((files.get("doomed.png")?.bytes ?? 0) > 0, "被删掉的文件也要能说出它有多大");
});

test("both sides of an image can be fetched for drawing", async () => {
	const before = await readDiffBlob(repo, "kept.png", "head");
	const after = await readDiffBlob(repo, "kept.png", "work");
	assert.match(before?.dataUrl ?? "", /^data:image\/png;base64,/);
	assert.match(after?.dataUrl ?? "", /^data:image\/png;base64,/);
	assert.notEqual(before?.dataUrl, after?.dataUrl, "改动前后取到了同一张图");
});

test("a deleted image is still readable from git, which is the only place it exists", async () => {
	assert.ok(await readDiffBlob(repo, "doomed.png", "head"));
	assert.equal(await readDiffBlob(repo, "doomed.png", "work"), null);
});

test("an added image has a working copy and no committed one", async () => {
	assert.ok(await readDiffBlob(repo, "added.png", "work"));
	assert.equal(await readDiffBlob(repo, "added.png", "head"), null);
});

test("only file types that can be drawn are offered as pictures", async () => {
	assert.equal(previewType("a/b/logo.png"), "image/png");
	assert.equal(previewType("photo.JPG"), "image/jpeg");
	assert.equal(previewType("icon.svg"), "image/svg+xml");
	assert.equal(previewType("bundle.zip"), null);
	assert.equal(previewType("Makefile"), null);
	assert.equal(await readDiffBlob(repo, "archive.zip", "work"), null);
});

test("a path pointing out of the repository is refused rather than read", async () => {
	// The panel hands this straight to an `<img>`; a traversal here would be a file-read primitive.
	assert.equal(await readDiffBlob(repo, "../../../etc/hosts.png", "work"), null);
});
