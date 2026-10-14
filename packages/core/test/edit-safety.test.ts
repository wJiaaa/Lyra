import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, mkdir, rename, symlink, link, stat, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { strToU8, zipSync } from "fflate";
import { editTool } from "../src/tools/edit.ts";
import { readTool } from "../src/tools/read.ts";
import { writeTool } from "../src/tools/write.ts";
import type { ToolContext, ToolResult } from "../src/types.ts";

const text = (result: ToolResult) => result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
async function fixture(t: { after(fn: () => Promise<void>): void }, content = "a\nb\nc\nd\n") {
	const cwd = await mkdtemp(join(tmpdir(), "plume-edit-safety-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const path = join(cwd, "sample.txt");
	await writeFile(path, content);
	const ctx: ToolContext = { cwd, sessionId: "safety", state: new Map() };
	return { cwd, path, ctx };
}

test("a window the model asked for lets it edit outside that window", async (t) => {
	const { path, ctx } = await fixture(t, "a\nb\nc\nd\n");
	await readTool.execute({ path, offset: 1, limit: 2 }, ctx);
	// 同 ZCode：不记哪几行显示过，只看最近一次读是不是没要求就被截短了。
	assert.notEqual((await editTool.execute({ path, old_string: "c\nd", new_string: "C\nD" }, ctx)).isError, true);
	assert.equal(await readFile(path, "utf8"), "a\nb\nC\nD\n");
});

test("编辑结果带回改动处现在的样子，下一次编辑不用先重读", async (t) => {
	const original = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
	const { path, ctx } = await fixture(t, original);
	await readTool.execute({ path }, ctx);
	const shown = text(await editTool.execute({ path, old_string: "line 3\n", new_string: "line 3\nx1\nx2\n" }, ctx));
	// 改动处加上下各一行。
	assert.match(shown, /^3→line 3\n4→x1\n5→x2\n6→line 4$/m);
	assert.doesNotMatch(shown, /line 10/, "离改动远的行不回显");
});

test("改动太大时只给新行号范围，不把整段回显", async (t) => {
	const { path, ctx } = await fixture(t, "a\nb\n");
	await readTool.execute({ path }, ctx);
	const payload = Array.from({ length: 80 }, (_, i) => `n${i}\n`).join("");
	const shown = text(await editTool.execute({ path, old_string: "a\n", new_string: `a\n${payload}` }, ctx));
	assert.match(shown, /Changed regions now at lines 1-82/);
	assert.doesNotMatch(shown, /n40/);
});

test("a stale read record refuses the edit until the file is read again", async (t) => {
	const { path, ctx } = await fixture(t);
	await readTool.execute({ path }, ctx);
	const changed = "USER\na\nb\nc\nd\n";
	await writeFile(path, changed);
	assert.equal((await editTool.execute({ path, old_string: "USER", new_string: "bad" }, ctx)).isError, true);
	assert.equal(await readFile(path, "utf8"), changed);
	await readTool.execute({ path }, ctx);
	assert.notEqual((await editTool.execute({ path, old_string: "a\n", new_string: "A\n" }, ctx)).isError, true);
});

test("replacements preserve dollar expressions literally", async (t) => {
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

test("edits keep CRLF and a missing final newline", async (t) => {
	const { path, ctx } = await fixture(t, "a\r\nb\r\nc");
	await readTool.execute({ path }, ctx);
	assert.notEqual((await editTool.execute({ path, old_string: "b\nc", new_string: "B\nc\nD" }, ctx)).isError, true);
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
	// 工作区外本身可以写（要问），但借一个看起来在工作区里的名字写出去不行：审批卡上只会写着这个名字。
	const escaped = await editTool.execute({ path: "escape.txt", old_string: "a", new_string: "bad" }, ctx);
	assert.equal(escaped.isError, true);
	assert.match(escaped.content[0].type === "text" ? escaped.content[0].text : "", /is a link to .*outside the workspace/);
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

test("an empty old_string points at write, and replacing everything with nothing leaves zero bytes", async (t) => {
	const { path, ctx } = await fixture(t, "first\nsecond");
	await readTool.execute({ path }, ctx);
	assert.match(text(await editTool.execute({ path, old_string: "", new_string: "x" }, ctx)), /use `write`/);
	assert.notEqual((await editTool.execute({ path, old_string: "first\nsecond", new_string: "" }, ctx)).isError, true);
	assert.equal((await stat(path)).size, 0);
});
