/**
 * 在 git 仓库里，`glob`、grep（ripgrep 与兜底）、symbol 索引看到的是同一份文件：认 `.gitignore`，
 * 不认目录名，隐藏的也算。
 *
 * 项目根经一个软链进来：git 报的是解析过的真实路径，结果里的路径仍要相对调用方给的那个目录。
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { buildIndex } from "../src/index/symbols.ts";
import { globTool } from "../src/tools/glob.ts";
import { grepTool } from "../src/tools/grep.ts";

const ctx = (cwd: string) => ({ cwd, sessionId: "s", state: new Map<string, unknown>() });

/** 返回经软链指向仓库的那个路径。 */
async function repo(t: TestContext, files: Record<string, string>): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "plume-project-files-"));
	const saved = { PLUME_HOME: process.env.PLUME_HOME, PLUME_RIPGREP: process.env.PLUME_RIPGREP };
	// 问 git 要经 `host-git.ts` 在 `plumeHome()` 下建临时视图，不能落到真实的 ~/.plume。
	process.env.PLUME_HOME = join(dir, "home");
	t.after(async () => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(dir, { recursive: true, force: true });
	});
	const real = join(dir, "real");
	for (const [path, content] of Object.entries(files)) {
		await mkdir(dirname(join(real, path)), { recursive: true });
		await writeFile(join(real, path), content);
	}
	execFileSync("git", ["init", "-q"], { cwd: real });
	execFileSync("git", ["add", "-A"], { cwd: real });
	const linked = join(dir, "linked");
	await symlink(real, linked, "dir");
	return linked;
}

const FILES = {
	".gitignore": "release/\n",
	"build/entitlements.plist": "<plist/>",
	"release/Plume.app/Info.plist": "<plist/>",
	"gone.plist": "<plist/>",
	".github/ci.plist": "<plist/>",
};

test("glob：提交了的 build/ 和隐藏的 .github/ 照找，被忽略的 release/ 不出现，工作区删掉的不报", async (t) => {
	const cwd = await repo(t, FILES);
	await rm(join(cwd, "gone.plist"));

	const res = await globTool.execute({ pattern: "**/*.plist" }, ctx(cwd));

	assert.deepEqual((res.details as { files: string[] }).files.sort(), [".github/ci.plist", "build/entitlements.plist"]);
});

test("grep 兜底：软链下的项目，路径相对项目根而不是 ../../真实路径；隐藏目录照搜", async (t) => {
	const cwd = await repo(t, { "a.txt": "needle\n", ".github/ci.yml": "needle\n", "release/b.txt": "needle\n", ".gitignore": "release/\n" });
	process.env.PLUME_RIPGREP = join(tmpdir(), "plume-no-such-ripgrep");

	const res = await grepTool.execute({ pattern: "needle" }, ctx(cwd));

	assert.deepEqual(res.content.map((part) => ("text" in part ? part.text : "")).join("").split("\n").sort(), [".github/ci.yml:1:needle", "a.txt:1:needle"]);
});

test("grep 兜底：不带 / 的 glob 和 ripgrep 一样比文件名，任意深度都算", async (t) => {
	const cwd = await repo(t, { "top.ts": "needle\n", "src/deep.ts": "needle\n", "src/deep.js": "needle\n" });
	process.env.PLUME_RIPGREP = join(tmpdir(), "plume-no-such-ripgrep");

	const res = await grepTool.execute({ pattern: "needle", glob: "*.ts" }, ctx(cwd));

	assert.deepEqual(res.content.map((part) => ("text" in part ? part.text : "")).join("").split("\n").sort(), ["src/deep.ts:1:needle", "top.ts:1:needle"]);
});

const NO_SHELL_SPAWN = process.platform === "win32" ? "a shell script cannot stand in for rg.exe without spawning through a shell" : false;

test("ripgrep：仓库里加 --hidden 并排除 .git，仓库外不加", { skip: NO_SHELL_SPAWN }, async (t) => {
	const cwd = await repo(t, { "a.txt": "needle\n" });
	const outside = await mkdtemp(join(tmpdir(), "plume-not-a-repo-"));
	t.after(() => rm(outside, { recursive: true, force: true }));
	// 只记下收到的参数，按「没有命中」退出。
	const log = join(outside, "argv.log");
	const fake = join(outside, "rg");
	await writeFile(fake, `#!/bin/sh\necho "$*" >> '${log}'\nexit 1\n`);
	await chmod(fake, 0o755);
	process.env.PLUME_RIPGREP = fake;

	await grepTool.execute({ pattern: "needle" }, ctx(cwd));
	await grepTool.execute({ pattern: "needle" }, ctx(outside));

	const [inRepo, outRepo] = (await readFile(log, "utf8")).trim().split("\n");
	assert.match(inRepo, /--hidden --glob !\.git /);
	assert.doesNotMatch(outRepo, /--hidden/);
});

test("symbol 索引：被忽略的目录不进；提交了的 vendor/ 仍按名单不进", async (t) => {
	const cwd = await repo(t, {
		".gitignore": "ios/\n",
		"src/app.ts": "export function app() {}",
		"ios/AppDelegate.swift": "class AppDelegate {}",
		"vendor/lib.ts": "export function lib() {}",
	});

	const files = new Set((await buildIndex(cwd)).symbols.map((entry) => entry.file));

	assert.deepEqual([...files], ["src/app.ts"]);
});
