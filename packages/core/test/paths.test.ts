import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { scratchHome } from "../src/runtime/previews.ts";
import { readTool } from "../src/tools/read.ts";
import { resolveWorkspacePath } from "../src/tools/paths.ts";

const HOME = join(tmpdir(), "ly-paths-home");
process.env.PLUME_HOME = HOME;

const CWD = join(tmpdir(), "ly-paths-project");

test("paths inside the workspace resolve, relative or absolute", () => {
	assert.equal(resolveWorkspacePath(CWD, "src/index.ts"), join(CWD, "src/index.ts"));
	assert.equal(resolveWorkspacePath(CWD, join(CWD, "a/b.txt")), join(CWD, "a/b.txt"));
	assert.equal(resolveWorkspacePath(CWD, "."), resolve(CWD));
});

/** 工作区外不在这里拒，交给工具发起的审批；这里只负责解析成绝对路径。 */
test("paths outside the workspace resolve, and are left to the approval", () => {
	assert.equal(resolveWorkspacePath(CWD, "/etc/passwd"), resolve("/etc/passwd"));
	assert.equal(resolveWorkspacePath(CWD, "../sibling/file.ts"), resolve(CWD, "../sibling/file.ts"));
	assert.equal(resolveWorkspacePath(CWD, "~/Desktop/notes.md"), join(homedir(), "Desktop/notes.md"));
});

test("the scratch directory is writable, because the model is told to use it", () => {
	const scratch = scratchHome(HOME);
	const file = join(scratch, "session-1", "notes.md");
	assert.equal(resolveWorkspacePath(CWD, file), file);
});

/**
 * The exception is the scratch subtree and nothing above it — settings, credentials and every
 * transcript live in the same parent directory.
 */
test("the rest of the app's home stays closed", () => {
	for (const bad of [join(HOME, "settings.json"), join(HOME, "sessions/x.jsonl"), join(HOME, "scratch/../settings.json")]) {
		assert.throws(() => resolveWorkspacePath(CWD, bad), /Plume's own data directory/, bad);
	}
});

test("a missing path is an error rather than the workspace root", () => {
	assert.throws(() => resolveWorkspacePath(CWD, ""), /A path is required/);
});

/**
 * 这里只剩「写」这一侧。
 *
 * 附件许可和技能文件例外都搬去了 `read-access.ts`——它们回答的是「能不能看」，而这个函数如今
 * 只回答「能不能改」，两者故意不再是同一个答案（见该文件与 `read-access.test.ts`）。留在这里的
 * 是那条不能松的：应用自己的目录写不进去，技能文件也不行。
 */
test("nothing in the app's home is writable, skill files included", () => {
	const skill = join(HOME, "plugins", "waza", "skills", "check", "references", "mode-audit.md");
	for (const bad of [
		skill,
		join(HOME, "skills", "ui", "SKILL.md"),
		join(HOME, "plugins", "waza", "manifest.json"),
		join(HOME, "settings.json"),
	]) {
		assert.throws(() => resolveWorkspacePath(CWD, bad), /Plume's own data directory/, bad);
	}
});

test("a workspace that lives under the app's home is still writable", () => {
	const cwd = join(HOME, "git-views", "proj");
	assert.equal(resolveWorkspacePath(cwd, "a.ts"), join(cwd, "a.ts"));
});

test("read opens an installed plugin skill file that used to escape the workspace", async () => {
	const skill = join(HOME, "plugins", "waza", "skills", "check", "references", "mode-audit.md");
	await mkdir(dirname(skill), { recursive: true });
	await writeFile(skill, "# mode-audit\nread me\n");
	const res = await readTool.execute({ path: skill }, { cwd: CWD, sessionId: "s", state: new Map() });
	assert.equal(res.isError, undefined);
	assert.match(res.content[0].text, /mode-audit/);
});

test("a write accepts the Windows shell spellings a read accepts", { skip: process.platform !== "win32" }, () => {
	// 读取侧早就认 Git Bash 的 `/c/…` 和 PowerShell 的 `~\`，写入侧只认 `~/`，同一个文件读得到、改不了。
	const cwd = "C:\\work\\proj";
	assert.equal(resolveWorkspacePath(cwd, "/c/work/proj/a.ts"), "C:\\work\\proj\\a.ts");
	assert.equal(resolveWorkspacePath(cwd, "~\\notes.txt"), join(homedir(), "notes.txt"));
});
