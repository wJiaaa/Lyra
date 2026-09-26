import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, mkdir, rename, symlink, link, stat, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { strToU8, zipSync } from "fflate";
import { editTool } from "../src/tools/edit.ts";
import { readTool } from "../src/tools/read.ts";
import { writeTool } from "../src/tools/write.ts";
import { snapshotTag } from "../src/tools/hunk.ts";
import type { ToolContext, ToolResult } from "../src/types.ts";

const text = (result: ToolResult) => result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
async function fixture(t: { after(fn: () => Promise<void>): void }, content = "a\nb\nc\nd\n") {
	const cwd = await mkdtemp(join(tmpdir(), "lyra-edit-safety-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const path = join(cwd, "sample.txt");
	await writeFile(path, content);
	const ctx: ToolContext = { cwd, sessionId: "safety", state: new Map() };
	return { cwd, path, ctx };
}

test("an insertion inside a replaced range is rejected without touching the file", async (t) => {
	const { path, ctx } = await fixture(t);
	await readTool.execute({ path }, ctx);
	const result = await editTool.execute({ path, tag: snapshotTag("a\nb\nc\nd\n"), patch: "REPLACE 2-3\n+B\nINSERT AFTER 2\n+X" }, ctx);
	assert.equal(result.isError, true);
	assert.match(text(result), /overlap|inside/i);
	assert.equal(await readFile(path, "utf8"), "a\nb\nc\nd\n");
});

test("partial reads retain their boundaries after edits shift line numbers", async (t) => {
	const original = "a\nb\nc\nd\n";
	const { path, ctx } = await fixture(t, original);
	await readTool.execute({ path, offset: 1, limit: 2 }, ctx);
	const first = await editTool.execute({ path, tag: snapshotTag(original), patch: "INSERT AFTER 1\n+inserted" }, ctx);
	assert.notEqual(first.isError, true);
	const tag = /New tag: ([0-9A-F]{4})/.exec(text(first))![1];
	const unseen = await editTool.execute({ path, tag, patch: "REPLACE 4-4\n+bad" }, ctx);
	assert.equal(unseen.isError, true);
	const seen = await editTool.execute({ path, tag, patch: "REPLACE 3-3\n+B" }, ctx);
	assert.notEqual(seen.isError, true);
	assert.equal(await readFile(path, "utf8"), "a\ninserted\nB\nc\nd\n");
});

test("copying the current tag cannot bypass a stale read record", async (t) => {
	const { path, ctx } = await fixture(t);
	await readTool.execute({ path }, ctx);
	const changed = "USER\na\nb\nc\nd\n";
	await writeFile(path, changed);
	const result = await editTool.execute({ path, tag: snapshotTag(changed), patch: "REPLACE 1-1\n+bad" }, ctx);
	assert.equal(result.isError, true);
	assert.equal(await readFile(path, "utf8"), changed);
	await readTool.execute({ path }, ctx);
	assert.notEqual((await editTool.execute({ path, tag: snapshotTag(changed), patch: "REPLACE 2-2\n+A" }, ctx)).isError, true);
});

test("legacy replacements preserve dollar expressions literally", async (t) => {
	const { path, ctx } = await fixture(t, "OLD");
	await readTool.execute({ path }, ctx);
	const replacement = "$& $$ $` $'";
	assert.notEqual((await editTool.execute({ path, old_string: "OLD", new_string: replacement }, ctx)).isError, true);
	assert.equal(await readFile(path, "utf8"), replacement);
});

test("overlapping text matches are ambiguous unless replace_all is explicit", async (t) => {
	const { path, ctx } = await fixture(t, "aaa");
	await readTool.execute({ path }, ctx);
	assert.equal((await editTool.execute({ path, old_string: "aa", new_string: "X" }, ctx)).isError, true);
	assert.equal(await readFile(path, "utf8"), "aaa");
	assert.notEqual((await editTool.execute({ path, old_string: "aa", new_string: "X", replace_all: true }, ctx)).isError, true);
	assert.equal(await readFile(path, "utf8"), "Xa");
});

test("inserts at a range boundary work, while duplicate anchors are rejected", async (t) => {
	const { path, ctx } = await fixture(t);
	await readTool.execute({ path }, ctx);
	const tag = snapshotTag("a\nb\nc\nd\n");
	assert.equal((await editTool.execute({ path, tag, patch: "INSERT AFTER 2\n+X\nINSERT AFTER 2\n+Y" }, ctx)).isError, true);
	assert.equal(await readFile(path, "utf8"), "a\nb\nc\nd\n");
	assert.notEqual((await editTool.execute({ path, tag, patch: "REPLACE 1-2\n+AB\nINSERT AFTER 2\n+X" }, ctx)).isError, true);
	assert.equal(await readFile(path, "utf8"), "AB\nX\nc\nd\n");
});

test("patch edits keep CRLF and a missing final newline", async (t) => {
	const original = "a\r\nb\r\nc";
	const { path, ctx } = await fixture(t, original);
	await readTool.execute({ path }, ctx);
	assert.notEqual((await editTool.execute({ path, tag: snapshotTag(original.replaceAll("\r\n", "\n")), patch: "REPLACE 2-2\n+B\nINSERT AFTER 3\n+D" }, ctx)).isError, true);
	assert.equal(await readFile(path, "utf8"), "a\r\nB\r\nc\r\nD");
});

test("a path replaced with identical content during approval is preserved", async (t) => {
	const { path, ctx, cwd } = await fixture(t);
	await readTool.execute({ path }, ctx);
	ctx.requestApproval = async () => {
		await rename(path, join(cwd, "original.txt"));
		await writeFile(path, "a\nb\nc\nd\n");
		return "once";
	};
	assert.equal((await editTool.execute({ path, old_string: "a", new_string: "A" }, ctx)).isError, true);
	assert.equal(await readFile(path, "utf8"), "a\nb\nc\nd\n");
});

test("concurrent edit and write share a file queue and preserve both changes", async (t) => {
	const { path, ctx } = await fixture(t);
	await readTool.execute({ path }, ctx);
	const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
	let approvals = 0;
	ctx.requestApproval = async () => {
		if (++approvals === 1) { entered.resolve(); await release.promise; }
		return "once";
	};
	const first = writeTool.execute({ path, content: "a\nb\nc\nwritten\n" }, ctx);
	await entered.promise;
	const second = editTool.execute({ path, old_string: "a", new_string: "A" }, ctx);
	release.resolve();
	const results = await Promise.all([first, second]);
	assert.ok(results.every((result) => !result.isError), results.map(text).join("\n"));
	assert.equal(await readFile(path, "utf8"), "A\nb\nc\nwritten\n");
});

test("reading an image does not authorize text editing or overwriting it", async (t) => {
	const { cwd, ctx } = await fixture(t);
	const path = join(cwd, "image.png"), bytes = Buffer.from([137, 80, 78, 71, 0, 255]);
	await writeFile(path, bytes);
	await readTool.execute({ path }, ctx);
	assert.equal((await editTool.execute({ path, old_string: "PNG", new_string: "bad" }, ctx)).isError, true);
	assert.equal((await writeTool.execute({ path, content: "bad" }, ctx)).isError, true);
	assert.deepEqual(await readFile(path), bytes);
});

test("extracted documents and invalid UTF-8 cannot be overwritten as text", async (t) => {
	const { cwd, ctx } = await fixture(t);
	const document = zipSync({ "word/document.xml": strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>TEXT</w:t></w:r></w:p></w:body></w:document>') });
	for (const [name, bytes] of [["sample.docx", document], ["invalid.txt", Buffer.from([0xc3, 0x28])]] as const) {
		const path = join(cwd, name); await writeFile(path, bytes);
		const read = await readTool.execute({ path }, ctx);
		if (name.endsWith("docx")) { assert.notEqual(read.isError, true); assert.match(text(read), /TEXT/); }
		assert.equal((await writeTool.execute({ path, content: "bad" }, ctx)).isError, true);
		assert.equal((await editTool.execute({ path, old_string: "TEXT", new_string: "bad" }, ctx)).isError, true);
		assert.deepEqual(await readFile(path), Buffer.from(bytes));
	}
});

test("file aliases share read records and writes refuse symlink escapes", { skip: process.platform === "win32" }, async (t) => {
	const { cwd, path, ctx } = await fixture(t);
	const project = join(cwd, "project"); await mkdir(project);
	const inside = join(project, "inside.txt"); await writeFile(inside, "before");
	await symlink(inside, join(project, "alias.txt"));
	ctx.cwd = project;
	await readTool.execute({ path: "alias.txt" }, ctx);
	assert.notEqual((await editTool.execute({ path: inside, old_string: "before", new_string: "after" }, ctx)).isError, true);
	await symlink(path, join(project, "escape.txt"));
	await readTool.execute({ path: "escape.txt" }, ctx);
	assert.equal((await editTool.execute({ path: "escape.txt", old_string: "a", new_string: "bad" }, ctx)).isError, true);
	assert.equal(await readFile(path, "utf8"), "a\nb\nc\nd\n");
});

test("hard links share a queue, keep their inode and reject another session's stale edit", async (t) => {
	const { cwd, path, ctx } = await fixture(t);
	const alias = join(cwd, "hard.txt"); await link(path, alias);
	if (process.platform !== "win32") await chmod(path, 0o755);
	const before = await stat(path);
	const other: ToolContext = { ...ctx, state: new Map() };
	await readTool.execute({ path }, ctx); await readTool.execute({ path: alias }, other);
	const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
	ctx.requestApproval = async () => { entered.resolve(); await release.promise; return "once"; };
	const first = editTool.execute({ path, old_string: "a", new_string: "first" }, ctx);
	await entered.promise;
	let secondFinished = false;
	const second = editTool.execute({ path: alias, old_string: "b", new_string: "second" }, other).then((result) => { secondFinished = true; return result; });
	try { await new Promise((resolve) => setTimeout(resolve, 50)); assert.equal(secondFinished, false); }
	finally { release.resolve(); }
	assert.notEqual((await first).isError, true); assert.equal((await second).isError, true);
	assert.equal(await readFile(alias, "utf8"), "first\nb\nc\nd\n");
	const after = await stat(alias);
	assert.equal(after.ino, before.ino); assert.equal(after.mode, before.mode);
});

test("approval-time content changes and new files cannot be overwritten", async (t) => {
	const { cwd, path, ctx } = await fixture(t);
	await readTool.execute({ path }, ctx);
	ctx.requestApproval = async () => { await writeFile(path, "external"); return "once"; };
	assert.equal((await editTool.execute({ path, old_string: "a", new_string: "A" }, ctx)).isError, true);
	assert.equal(await readFile(path, "utf8"), "external");
	const created = join(cwd, "new.txt");
	ctx.requestApproval = async () => { await writeFile(created, "external"); return "once"; };
	assert.equal((await writeTool.execute({ path: created, content: "bad" }, ctx)).isError, true);
	assert.equal(await readFile(created, "utf8"), "external");
});

test("rejection and cancellation leave bytes intact and release the queue", async (t) => {
	const { path, ctx } = await fixture(t);
	await readTool.execute({ path }, ctx);
	ctx.requestApproval = async () => "reject";
	assert.equal((await editTool.execute({ path, old_string: "a", new_string: "A" }, ctx)).isError, true);
	const controller = new AbortController(); ctx.signal = controller.signal;
	ctx.requestApproval = async () => { controller.abort(); return "once"; };
	assert.equal((await writeTool.execute({ path, content: "bad" }, ctx)).isError, true);
	assert.equal(await readFile(path, "utf8"), "a\nb\nc\nd\n");
	ctx.signal = undefined; ctx.requestApproval = undefined;
	assert.notEqual((await editTool.execute({ path, old_string: "a", new_string: "A" }, ctx)).isError, true);
});

test("an empty file can be inserted into and deleting all lines leaves zero bytes", async (t) => {
	const { path, ctx } = await fixture(t, "");
	await readTool.execute({ path }, ctx);
	assert.notEqual((await editTool.execute({ path, tag: snapshotTag(""), patch: "INSERT AFTER 0\n+first\n+second" }, ctx)).isError, true);
	assert.equal(await readFile(path, "utf8"), "first\nsecond");
	assert.notEqual((await editTool.execute({ path, tag: snapshotTag("first\nsecond"), patch: "DELETE 1-2" }, ctx)).isError, true);
	assert.equal((await stat(path)).size, 0);
});

test("short tag collisions cannot authorize edits or retain old visible ranges", async (t) => {
	const candidates = new Map<string, string>();
	let first = "", second = "";
	for (let n = 0; n <= 65536; n++) {
		second = `line ${n}\nunseen\n`;
		const tag = snapshotTag(second), previous = candidates.get(tag);
		if (previous) { first = previous; break; }
		candidates.set(tag, second);
	}
	assert.ok(first); assert.equal(snapshotTag(first), snapshotTag(second));
	const { path, ctx } = await fixture(t, first);
	await readTool.execute({ path, offset: 2, limit: 1 }, ctx);
	await writeFile(path, second);
	assert.equal((await editTool.execute({ path, tag: snapshotTag(second), patch: "REPLACE 2-2\n+bad" }, ctx)).isError, true);
	await readTool.execute({ path, offset: 1, limit: 1 }, ctx);
	assert.equal((await editTool.execute({ path, tag: snapshotTag(second), patch: "REPLACE 2-2\n+bad" }, ctx)).isError, true);
	assert.equal(await readFile(path, "utf8"), second);
});
