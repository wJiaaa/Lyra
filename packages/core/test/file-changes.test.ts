import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, test } from "node:test";
import { execFileSync } from "node:child_process";
import { recordFileChange, readFileChange, undoFileChanges, undoFileChangeBatches } from "../src/tools/file-changes.ts";
import { beforeCommand, afterCommand } from "../src/tools/command-changes.ts";
import { computeDiff } from "../src/tools/diff.ts";
import type { ToolContext } from "../src/types.ts";
import { asWindows, refuseRenames } from "./held-open.ts";
let home: string, cwd: string, ctx: ToolContext;
let prior: string | undefined;
beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "plume-change-test-")); cwd = join(home, "project"); await mkdir(cwd);
	prior = process.env.PLUME_HOME; process.env.PLUME_HOME = home;
	ctx = { cwd, sessionId: "test-session", state: new Map(), scratchDir: join(home, "scratch") };
});
afterEach(async () => { if (prior === undefined) delete process.env.PLUME_HOME; else process.env.PLUME_HOME = prior; await rm(home, { recursive: true, force: true }); });
test("chained edits undo only this turn, preserving the user's initial dirty content", async () => {
	const path = join(cwd, "main.ts"); const initial = "user work\n";
	const a = await recordFileChange(ctx, path, initial, "user work\nfirst\n"); assert.ok(a);
	const b = await recordFileChange(ctx, path, "user work\nfirst\n", "user work\nsecond\n"); assert.ok(b);
	await writeFile(path, "user work\nsecond\n");
	await undoFileChanges(cwd, await Promise.all([a,b].map((id) => readFileChange(ctx.sessionId, id))));
	assert.equal(await readFile(path, "utf8"), initial);
});
test("undo refuses later edits, discontinuous histories and records from another session", async () => {
	const path = join(cwd, "file.ts"), id = await recordFileChange(ctx, path, "before", "after"); assert.ok(id);
	const change = await readFileChange(ctx.sessionId, id); await writeFile(path, "new user work");
	await assert.rejects(undoFileChanges(cwd, [change]), /后续修改/);
	assert.equal(await readFile(path, "utf8"), "new user work");
	await assert.rejects(readFileChange("other-session", id));
	await assert.rejects(readFileChange(ctx.sessionId, "../../settings.json"), /无效/);
	await assert.rejects(undoFileChanges(cwd, [change, {...change, before: "unrelated"}]), /其他修改/);
});
test("new files are removed only while still equal to the recorded result", async () => {
	const path = join(cwd, "new.ts"), id = await recordFileChange(ctx, path, null, "created"); assert.ok(id);
	await writeFile(path, "created"); await undoFileChanges(cwd, [await readFileChange(ctx.sessionId, id)]);
	await assert.rejects(readFile(path), {code:"ENOENT"});
});
test("command snapshots compare against the working file, including staged additions", async () => {
	const git = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args], {stdio:"pipe"});
	git("init"); git("config", "user.email", "test@example.invalid"); git("config", "user.name", "Test");
	await writeFile(join(cwd,"existing.ts"), "base\n"); git("add", "."); git("commit", "-m", "base");
	await writeFile(join(cwd,"existing.ts"), "user dirty\n");
	await writeFile(join(cwd,"staged.ts"), "one\ntwo\n"); git("add", "staged.ts");
	const snapshot = await beforeCommand(ctx);
	await writeFile(join(cwd,"staged.ts"), "one\nupdated\n");
	const ids = await afterCommand(ctx, snapshot); assert.equal(ids.length, 1);
	const change = await readFileChange(ctx.sessionId, ids[0]); assert.equal(change.before, "one\ntwo\n"); assert.equal(change.after, "one\nupdated\n");
	await assert.rejects(undoFileChanges(cwd, [change]), /命令/);
	assert.equal(await readFile(join(cwd,"existing.ts"), "utf8"), "user dirty\n");
});

test("a CRLF checkout's command change is recorded against the file as checked out, not the LF blob", async () => {
	// `.gitattributes` rather than `core.autocrlf`, so this reproduces on every platform: the blob is
	// stored LF, the working file is CRLF, and `git show` hands back the blob as stored.
	const git = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args], {stdio:"pipe"});
	git("init"); git("config", "user.email", "test@example.invalid"); git("config", "user.name", "Test");
	await writeFile(join(cwd, ".gitattributes"), "* text eol=crlf\n");
	const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
	await writeFile(join(cwd, "big.txt"), `${lines.join("\r\n")}\r\n`); git("add", "."); git("commit", "-m", "base");
	const snapshot = await beforeCommand(ctx);
	lines[20] = "changed";
	await writeFile(join(cwd, "big.txt"), `${lines.join("\r\n")}\r\n`);
	const ids = await afterCommand(ctx, snapshot); assert.equal(ids.length, 1);
	const change = await readFileChange(ctx.sessionId, ids[0]);
	assert.ok(change.before?.includes("line 20\r\n"), "改动前的内容要和检出到磁盘上的一样是 CRLF");
	const diff = computeDiff(change.before ?? "", change.after ?? "");
	assert.deepEqual([diff.added, diff.removed], [1, 1], "命令只改了一行，记下来的就是一行");
});

test("core.autocrlf in the repository's config still reaches the host-side conversion", async () => {
	// 宿主侧 git 读不到仓库配置，只读白名单键；autocrlf 必须在白名单里，否则又回到整文件改写。
	const git = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args], {stdio:"pipe"});
	git("init"); git("config", "user.email", "test@example.invalid"); git("config", "user.name", "Test");
	await writeFile(join(cwd, "a.txt"), "one\ntwo\nthree\n"); git("add", "."); git("commit", "-m", "base");
	git("config", "core.autocrlf", "true");
	await writeFile(join(cwd, "a.txt"), "one\r\ntwo\r\nthree\r\n");
	const snapshot = await beforeCommand(ctx);
	await writeFile(join(cwd, "a.txt"), "one\r\nTWO\r\nthree\r\n");
	const ids = await afterCommand(ctx, snapshot); assert.equal(ids.length, 1);
	const change = await readFileChange(ctx.sessionId, ids[0]);
	assert.equal(change.before, "one\r\ntwo\r\nthree\r\n");
});

test("host-side git never runs a program the sandboxed repository configured", { skip: process.platform === "win32" }, async () => {
	/*
	 * 沙箱内命令能写 `.git/config` 与 `.gitattributes`。这里把 git 会执行程序的入口全部埋上：
	 * filter（clean/smudge/process）、fsmonitor、textconv、外部 diff、钩子、partial clone 的惰性拉取。
	 * 宿主侧的快照一个都不能触发；最后用普通 git 再跑一遍，证明这些埋点确实是活的。
	 */
	const git = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });
	const marks = join(home, "marks"); await mkdir(marks);
	const mark = (name: string) => `sh -c 'touch "${marks}/${name}"; cat' --`;
	git("init"); git("config", "user.email", "test@example.invalid"); git("config", "user.name", "Test");
	await writeFile(join(cwd, "a.txt"), "one\n"); await writeFile(join(cwd, "b.txt"), "keep\n"); git("add", "."); git("commit", "-m", "base");
	await writeFile(join(cwd, ".gitattributes"), "a.txt filter=evil diff=evil\nb.txt filter=proc\n");
	git("config", "filter.evil.clean", mark("clean")); git("config", "filter.evil.smudge", mark("smudge"));
	git("config", "filter.proc.process", `sh -c 'touch "${marks}/process"'`);
	git("config", "diff.evil.textconv", `sh -c 'touch "${marks}/textconv"; cat "$1"' --`);
	git("config", "diff.external", `sh -c 'touch "${marks}/external"' --`);
	const hook = join(home, "hook.sh"); await writeFile(hook, `#!/bin/sh\ntouch "${marks}/$(basename "$0")"\n`, { mode: 0o755 });
	const hooks = join(home, "hooks"); await mkdir(hooks);
	for (const name of ["post-index-change", "reference-transaction"]) await fs.copyFile(hook, join(hooks, name)).then(() => fs.chmod(join(hooks, name), 0o755));
	git("config", "core.hooksPath", hooks);
	const fsmonitor = join(home, "fsmonitor.sh"); await writeFile(fsmonitor, `#!/bin/sh\ntouch "${marks}/fsmonitor"\n`, { mode: 0o755 });
	git("config", "core.fsmonitor", fsmonitor);
	await fs.rm(marks, { recursive: true }); await mkdir(marks);
	// 第一段：命令改了带 filter/diff 驱动的文件，宿主要算差异、要按检出方式还原原文。
	const first = await beforeCommand(ctx);
	await writeFile(join(cwd, "a.txt"), "two\n");
	const ids = await afterCommand(ctx, first);
	assert.equal(ids.length, 1);
	assert.equal((await readFileChange(ctx.sessionId, ids[0])).before, "one\n");
	assert.deepEqual(await fs.readdir(marks), [], "宿主侧 git 执行了仓库配置的程序");
	const plain = (...args: string[]) => { try { execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe", env: { ...process.env, GIT_PAGER: "cat" } }); } catch { /* 失败也已经执行过了 */ } };
	const live = async (...names: string[]) => {
		const fired = await fs.readdir(marks);
		for (const name of names) assert.ok(fired.includes(name), `埋点 ${name} 没生效，这个测试什么也证明不了：${fired.join(",")}`);
		await fs.rm(marks, { recursive: true }); await mkdir(marks);
	};
	plain("diff", "HEAD"); plain("cat-file", "--filters", "HEAD:a.txt");
	await live("fsmonitor", "clean", "smudge");

	// 第二段：命令顺手把 a.txt 的原 blob 删掉并声明 promisor：读它就会走 uploadpack。
	const blob = git("rev-parse", "HEAD:a.txt").toString().trim();
	await rm(join(cwd, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
	git("config", "core.repositoryformatversion", "1"); git("config", "extensions.partialClone", "evil");
	git("config", "remote.evil.url", cwd); git("config", "remote.evil.promisor", "true");
	git("config", "remote.evil.uploadpack", `sh -c 'touch "${marks}/uploadpack"; exit 1' --`);
	git("config", "protocol.file.allow", "always");
	git("config", "--unset", "core.fsmonitor");
	await fs.rm(marks, { recursive: true }); await mkdir(marks);
	const second = await beforeCommand(ctx).catch(() => null);
	await writeFile(join(cwd, "a.txt"), "three\n");
	// 缺了 blob 读不出来是可以的（记录退化为提示），执行拉取不行。
	await afterCommand(ctx, second).catch(() => []);
	assert.deepEqual(await fs.readdir(marks), [], "宿主侧 git 执行了仓库配置的拉取");
	plain("cat-file", "-p", "HEAD:a.txt");
	await live("uploadpack");
});

test("batch undo preflights all files before touching any and preserves existing dirty work", async () => {
	const a = join(cwd, "a.ts"), b = join(cwd, "b.ts");
	const aId = await recordFileChange(ctx, a, "user dirty", "agent edit"), bId = await recordFileChange(ctx, b, null, "new file");
	assert.ok(aId && bId);
	const changes = await Promise.all([aId, bId].map((id) => readFileChange(ctx.sessionId, id)));
	await writeFile(a, "agent edit"); await writeFile(b, "user follow-up");
	await assert.rejects(undoFileChangeBatches(cwd, changes.map((change) => [change])), /后续修改/);
	assert.equal(await readFile(a, "utf8"), "agent edit"); assert.equal(await readFile(b, "utf8"), "user follow-up");
	await writeFile(b, "new file"); await undoFileChangeBatches(cwd, changes.map((change) => [change]));
	assert.equal(await readFile(a, "utf8"), "user dirty"); await assert.rejects(readFile(b), { code: "ENOENT" });
});

test("an interrupted staged write leaves every original intact and removes temporary files", async (t) => {
	const path = join(cwd, "partial.ts");
	const id = await recordFileChange(ctx, path, "before", "after"); assert.ok(id); await writeFile(path, "after");
	const original = fs.writeFile;
	t.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
		if (String(args[0]).includes(".plume-undo-")) { await original(args[0], "part"); throw new Error("simulated ENOSPC"); }
		return original(...args);
	});
	await assert.rejects(undoFileChanges(cwd, [await readFileChange(ctx.sessionId, id)]), /ENOSPC/);
	assert.equal(await readFile(path, "utf8"), "after");
	assert.deepEqual(await fs.readdir(cwd), ["partial.ts"]);
});

test("concurrent batch and single-file undo cannot undo each other's committed result", async () => {
	const path = join(cwd, "concurrent.ts");
	const id = await recordFileChange(ctx, path, "before", "after"); assert.ok(id); await writeFile(path, "after");
	const changes = [await readFileChange(ctx.sessionId, id)];
	const results = await Promise.allSettled([undoFileChanges(cwd, changes), undoFileChangeBatches(cwd, [changes])]);
	assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
	assert.equal(await readFile(path, "utf8"), "before");
});

test("nested projects share the same undo transaction lock", async (t) => {
	const nested = join(cwd, "nested"); await mkdir(nested);
	const path = join(nested, "a.ts"); await writeFile(path, "after");
	const id = await recordFileChange(ctx, path, "before", "after"); assert.ok(id);
	const changes = [await readFileChange(ctx.sessionId, id)];
	const started = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
	const original = fs.writeFile;
	t.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
		if (String(args[0]).includes(".plume-undo-")) { started.resolve(); await gate.promise; }
		return original(...args);
	});
	const first = undoFileChanges(cwd, changes); await started.promise;
	const second = undoFileChanges(nested, changes);
	// The competing transaction must reject before the first one commits.
	const result = second.then(() => "committed", (error: Error) => error.message);
	gate.resolve(); await first;
	assert.match(await result, /正在撤销/);
});

test("undo and rollback preserve file modes despite the process umask", { skip: process.platform === "win32" }, async (t) => {
	const a = join(cwd, "a.sh"), b = join(cwd, "b.ts");
	await writeFile(a, "after"); await fs.chmod(a, 0o764);
	const id = await recordFileChange(ctx, a, "before", "after"); assert.ok(id);
	await undoFileChanges(cwd, [await readFileChange(ctx.sessionId, id)]);
	assert.equal((await fs.stat(a)).mode & 0o777, 0o764);
	await writeFile(a, "created"); await fs.chmod(a, 0o764); await writeFile(b, "after");
	const aId = await recordFileChange(ctx, a, null, "created"), bId = await recordFileChange(ctx, b, "before", "after"); assert.ok(aId && bId);
	const original = fs.writeFile; let fail = true;
	t.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
		if (fail && String(args[0]).includes(".plume-undo-")) { fail = false; throw new Error("simulated ENOSPC"); }
		return original(...args);
	});
	await assert.rejects(undoFileChangeBatches(cwd, await Promise.all([aId, bId].map(async id => [await readFileChange(ctx.sessionId, id)]))), /ENOSPC/);
	assert.equal(await readFile(a, "utf8"), "created");
	assert.equal((await fs.stat(a)).mode & 0o777, 0o764);
});

// The agent has just written the file, and on Windows whatever scans new files is holding it.
test("on Windows an undo refused for a moment is retried rather than failed", async (t) => {
	const path = join(cwd, "scanned.ts");
	const id = await recordFileChange(ctx, path, "before", "after"); assert.ok(id); await writeFile(path, "after");
	const change = await readFileChange(ctx.sessionId, id);
	asWindows(t);
	const { refused } = refuseRenames(t, "scanned.ts", "EPERM", 2);
	await undoFileChanges(cwd, [change]);
	assert.equal(refused(), 2, "the premise: the first two renames were refused");
	assert.equal(await readFile(path, "utf8"), "before");
});
