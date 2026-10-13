/**
 * `edit`, end to end through the tool.
 *
 * Through `editTool.execute` rather than unit pieces, because the parts most likely to break are the
 * seams — the read record, the stale check, and the re-record that lets a second edit in the same
 * turn succeed.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { editTool } from "../src/tools/edit.ts";
import { readTool } from "../src/tools/read.ts";
import { writeTool } from "../src/tools/write.ts";
import type { ToolContext, ToolResult } from "../src/types.ts";

const FIVE = "alpha\nbravo\ncharlie\ndelta\necho\n";

async function fixture(content = FIVE): Promise<{ dir: string; file: string; ctx: ToolContext }> {
	const dir = await mkdtemp(join(tmpdir(), "plume-edit-"));
	const file = join(dir, "sample.txt");
	await writeFile(file, content, "utf8");
	return { dir, file, ctx: { cwd: dir, sessionId: "t", state: new Map() } };
}

/** Read first, the way the agent must. */
async function read(ctx: ToolContext, file: string, args: Record<string, unknown> = {}) {
	return await readTool.execute({ path: file, ...args } as never, ctx);
}

const textOf = (res: ToolResult) => (res.content[0].type === "text" ? res.content[0].text : "");

test("read puts the path in a header and numbers the lines", async () => {
	const { file, ctx } = await fixture();
	const text = textOf(await read(ctx, file));
	assert.match(text, /^\[sample\.txt\]\n/);
	assert.match(text, /1→alpha/);
	assert.match(text, /5→echo/);
});

test("a unique match is replaced", async () => {
	const { file, ctx } = await fixture();
	await read(ctx, file);
	const res = await editTool.execute({ path: file, old_string: "bravo", new_string: "BRAVO" }, ctx);
	assert.equal(res.isError, undefined, textOf(res));
	assert.equal(await readFile(file, "utf8"), "alpha\nBRAVO\ncharlie\ndelta\necho\n");
});

test("one word on a very long line changes without retyping the line", async () => {
	/*
	 * 换成按原文替换的起因：一段一行的 LaTeX 里换一个词，行号补丁要把上千字的整行重打一遍。
	 * 这里只给那个词前后几个字，整行其余部分一个字不能动。
	 */
	const line = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
	const { file, ctx } = await fixture(`intro\n${line}\noutro\n`);
	await read(ctx, file);
	const res = await editTool.execute({ path: file, old_string: "word117 word118", new_string: "word117 swapped" }, ctx);
	assert.equal(res.isError, undefined, textOf(res));
	assert.equal(await readFile(file, "utf8"), `intro\n${line.replace("word117 word118", "word117 swapped")}\noutro\n`);
});

test("new_string is written literally, `$` sequences included", async () => {
	// `String.replace` reads `$$`, `$&`, `` $` `` and `$'` in a string replacement as patterns, so
	// shell and template code came out rewritten: `$$` lost a dollar, `$&` became the matched text.
	const { file, ctx } = await fixture("alpha\nPLACEHOLDER\ncharlie\n");
	await read(ctx, file);
	const literal = "echo $$ and $& and $` and $' and $1";
	const res = await editTool.execute({ path: file, old_string: "PLACEHOLDER", new_string: literal }, ctx);
	assert.equal(res.isError, undefined);
	assert.equal(await readFile(file, "utf8"), `alpha\n${literal}\ncharlie\n`);
});

test("several edits in one turn each see the file the previous one left", async () => {
	const { file, ctx } = await fixture();
	await read(ctx, file);
	const first = await editTool.execute({ path: file, old_string: "alpha", new_string: "ALPHA" }, ctx);
	assert.match(textOf(first), /Now reads:\n1→ALPHA/, "结果里带回改后的样子，省掉一次重读");
	const second = await editTool.execute({ path: file, old_string: "echo", new_string: "ECHO" }, ctx);
	assert.equal(second.isError, undefined, textOf(second));
	assert.equal(await readFile(file, "utf8"), "ALPHA\nbravo\ncharlie\ndelta\nECHO\n");
});

test("a file changed since it was read is not edited", async () => {
	const { file, ctx } = await fixture();
	await read(ctx, file);
	// Someone else touches the file between the read and the edit. Same size within the same millisecond would slip by; see `changedSince`.
	await writeFile(file, "alpha\nbravo\ncharlie\ndelta\nECHO!\n", "utf8");
	const res = await editTool.execute({ path: file, old_string: "bravo", new_string: "BRAVO" }, ctx);
	assert.equal(res.isError, true);
	assert.match(textOf(res), /changed since you read it/);
	assert.equal(await readFile(file, "utf8"), "alpha\nbravo\ncharlie\ndelta\nECHO!\n", "the file must be untouched");
});

test("text that is not in the file is refused with a hint about the line-number prefix", async () => {
	const { file, ctx } = await fixture();
	await read(ctx, file);
	const res = await editTool.execute({ path: file, old_string: "foxtrot", new_string: "BRAVO" }, ctx);
	assert.equal(res.isError, true);
	assert.match(textOf(res), /not found[\s\S]*line-number prefix/);
});

test("an ambiguous match asks for more context, and replace_all takes them all", async () => {
	const { file, ctx } = await fixture("dup\ndup\n");
	await read(ctx, file);
	const res = await editTool.execute({ path: file, old_string: "dup", new_string: "x" }, ctx);
	assert.equal(res.isError, true);
	assert.match(textOf(res), /appears 2 times[\s\S]*surrounding text/);
	const all = await editTool.execute({ path: file, old_string: "dup", new_string: "x", replace_all: true }, ctx);
	assert.equal(all.isError, undefined, textOf(all));
	assert.equal(await readFile(file, "utf8"), "x\nx\n");
});

test("editing without reading first is refused", async () => {
	const { file, ctx } = await fixture();
	const res = await editTool.execute({ path: file, old_string: "bravo", new_string: "x" }, ctx);
	assert.equal(res.isError, true);
	assert.match(textOf(res), /Read .* before editing/);
});

test("an edit without old_string is refused rather than guessed", async () => {
	const { file, ctx } = await fixture();
	await read(ctx, file);
	const res = await editTool.execute({ path: file, new_string: "x" } as never, ctx);
	assert.equal(res.isError, true);
	assert.equal(await readFile(file, "utf8"), FIVE);
});

test("read and edit work cleanly on explicitly allowed paths outside workspace", async (t) => {
	/*
	 * Under the home directory rather than in a temp one, because the temp areas are readable.
	 *
	 * `assessRead` allows `/tmp` and `os.tmpdir()` for the same reason `writableRoots` grants them:
	 * that is where work that should not touch the repository goes. A test that used a temp
	 * directory to stand for "outside the workspace" was testing a path that is no longer outside
	 * anything, and it passed for that reason rather than because the boundary held.
	 */
	const externalDir = await mkdtemp(join(homedir(), ".plume-external-"));
	const externalFile = join(externalDir, "external.txt");
	await writeFile(externalFile, FIVE, "utf8");
	t.after(() => rm(externalDir, { recursive: true, force: true }));

	const workspaceDir = await mkdtemp(join(tmpdir(), "plume-ws-"));
	const ctxWithoutAllowed: ToolContext = {
		cwd: workspaceDir,
		sessionId: "t2",
		state: new Map(),
	};
	const ctxWithAllowed: ToolContext = {
		...ctxWithoutAllowed,
		allowedPaths: new Set([externalFile]),
	};

	// Without allowedPaths — and with nobody to ask — the read is refused.
	const deniedRead = await readTool.execute({ path: externalFile } as never, ctxWithoutAllowed);
	assert.equal(deniedRead.isError, true);
	assert.match(deniedRead.content[0].type === "text" ? deniedRead.content[0].text : "", /没有可以询问的人/);

	// With allowedPaths, read succeeds
	const readRes = await readTool.execute({ path: externalFile } as never, ctxWithAllowed);
	assert.equal(readRes.isError, undefined);

	/*
	 * 但改不了——这条原来断言的是相反的事。
	 *
	 * 那份集合是用户拖进输入框的附件（`runtime/session-turn.ts` 的 `collectAllowedPaths`），拖进来
	 * 的意思是让模型看它。原来 `write`/`edit` 也吃同一份许可，于是一次「你看看我的 ~/.zshrc」就换来
	 * 了对它的写权限，在完全访问模式下全程不再问第二次；而 `MessageAttachment.path` 自己的类型注释
	 * 写着它只是展示用元数据，从没按权限凭证设计过。
	 */
	const editRes = await editTool.execute(
		{ path: externalFile, old_string: "bravo", new_string: "BRAVO_EXTERNAL" },
		ctxWithAllowed,
	);
	assert.equal(editRes.isError, true, "附件给的是读的许可，不该连写一起给");
	assert.match(editRes.content[0].type === "text" ? editRes.content[0].text : "", /escapes the workspace root/);
	assert.equal(await readFile(externalFile, "utf8"), FIVE, "文件一个字都不该被动过");
});

test("an attachment does not become a licence to overwrite the file either", async () => {
	// `write` 和 `edit` 是同一条边界上的两个入口，堵一个不堵另一个等于没堵。
	const externalDir = await mkdtemp(join(tmpdir(), "plume-external-"));
	const externalFile = join(externalDir, "external.txt");
	await writeFile(externalFile, FIVE, "utf8");
	const workspaceDir = await mkdtemp(join(tmpdir(), "plume-ws-"));
	const ctx: ToolContext = { cwd: workspaceDir, sessionId: "t3", state: new Map(), allowedPaths: new Set([externalFile]) };

	// 先读一遍：`write` 对已存在的文件要求先读过，绕开这一步会撞上另一条规则而不是边界本身。
	await readTool.execute({ path: externalFile } as never, ctx);
	const written = await writeTool.execute({ path: externalFile, content: "OVERWRITTEN" } as never, ctx);

	assert.equal(written.isError, true, "附件给的是读的许可，不该连覆写一起给");
	assert.equal(await readFile(externalFile, "utf8"), FIVE, "文件一个字都不该被动过");
});

test("a file just written can be edited in the same turn without a dummy read", async () => {
	const dir = await mkdtemp(join(tmpdir(), "plume-write-edit-"));
	const ctx: ToolContext = { cwd: dir, sessionId: "write-edit", state: new Map() };
	const created = await writeTool.execute({ path: "Sample.ts", content: "export const answer = 1;\n" } as never, ctx);
	assert.equal(created.isError, undefined, created.content[0].type === "text" ? created.content[0].text : "");
	const edited = await editTool.execute({ path: "Sample.ts", old_string: "answer = 1", new_string: "answer = 2" }, ctx);
	assert.equal(edited.isError, undefined, edited.content[0].type === "text" ? edited.content[0].text : "");
	assert.equal(await readFile(join(dir, "Sample.ts"), "utf8"), "export const answer = 2;\n");
});
