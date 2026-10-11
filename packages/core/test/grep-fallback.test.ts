/**
 * 没有 ripgrep 时，内置扫描器给出的结果要和 ripgrep 是同一回事：上下文不重复、被忽略的不出现。
 * 以及桌面端随包带的那份 ripgrep 经 `PLUME_RIPGREP` 真的被用上，搜单个文件时路径不带整条前缀。
 *
 * 兜底靠把 `PLUME_RIPGREP` 指向一个不存在的文件来逼出：留着 `PATH`，git 才找得到。
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { grepTool } from "../src/tools/grep.ts";

const ctx = (cwd: string) => ({ cwd, sessionId: "s", state: new Map<string, unknown>() });
const textOf = (res: Awaited<ReturnType<typeof grepTool.execute>>) => res.content.map((part) => ("text" in part ? part.text : "")).join("");

async function sandbox(t: TestContext, ripgrep: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "plume-grep-fb-"));
	const home = await mkdtemp(join(tmpdir(), "plume-grep-home-"));
	const saved = { PLUME_RIPGREP: process.env.PLUME_RIPGREP, PLUME_HOME: process.env.PLUME_HOME };
	process.env.PLUME_RIPGREP = ripgrep;
	// 问 git 要经 `host-git.ts` 在 `plumeHome()` 下建临时视图，不能落到真实的 ~/.plume。
	process.env.PLUME_HOME = home;
	t.after(async () => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(dir, { recursive: true, force: true });
		await rm(home, { recursive: true, force: true });
	});
	return dir;
}

const NO_RG = join(tmpdir(), "plume-no-such-ripgrep");

test("兜底：相邻命中的上下文重叠时，每行只出一次", async (t) => {
	const dir = await sandbox(t, NO_RG);
	await writeFile(join(dir, "tokens.css"), ["a", "b", "--radius-menu: 8px;", "--menu-inset: 4px;", "--radius-item: 6px;", "c", "d"].join("\n"));

	const lines = textOf(await grepTool.execute({ pattern: "radius|inset", context: 2 }, ctx(dir))).split("\n");

	assert.deepEqual(lines, [
		"tokens.css:1:a",
		"tokens.css:2:b",
		"tokens.css:3:--radius-menu: 8px;",
		"tokens.css:4:--menu-inset: 4px;",
		"tokens.css:5:--radius-item: 6px;",
		"tokens.css:6:c",
		"tokens.css:7:d",
	]);
});

test("兜底：git 仓库里被忽略的目录不搜，隐藏文件和未跟踪的照搜", async (t) => {
	const dir = await sandbox(t, NO_RG);
	execFileSync("git", ["init", "-q"], { cwd: dir });
	await writeFile(join(dir, ".gitignore"), "ios/\n");
	await mkdir(join(dir, "ios"));
	await mkdir(join(dir, "src"));
	await writeFile(join(dir, "ios", "Pods.txt"), "needle in ignored\n");
	await writeFile(join(dir, "src", "app.ts"), "needle in source\n");
	await writeFile(join(dir, ".rc"), "needle in dotfile\n");

	const found = textOf(await grepTool.execute({ pattern: "needle" }, ctx(dir)));

	assert.match(found, /src\/app\.ts:1:needle in source/);
	assert.match(found, /\.rc:1:needle in dotfile/);
	assert.doesNotMatch(found, /Pods/, "被 .gitignore 忽略的目录不该出现在结果里");
});

test("兜底：不在 git 仓库里时照旧按目录名单走", async (t) => {
	const dir = await sandbox(t, NO_RG);
	await mkdir(join(dir, "node_modules"));
	await writeFile(join(dir, "node_modules", "dep.js"), "needle\n");
	await writeFile(join(dir, "main.js"), "needle\n");

	const found = textOf(await grepTool.execute({ pattern: "needle" }, ctx(dir)));

	assert.match(found, /main\.js:1:needle/);
	assert.doesNotMatch(found, /node_modules/);
});

const NO_SHELL_SPAWN = process.platform === "win32" ? "a shell script cannot stand in for rg.exe without spawning through a shell" : false;

test("PLUME_RIPGREP 指定的 ripgrep 被用上；搜单个文件时只留文件名", { skip: NO_SHELL_SPAWN }, async (t) => {
	const bin = await mkdtemp(join(tmpdir(), "plume-grep-bin-"));
	t.after(() => rm(bin, { recursive: true, force: true }));
	// 只认 --json：照真 ripgrep 的样子，报的是传进来的那条路径本身。
	const fake = join(bin, "bundled-rg");
	await writeFile(fake, `#!/bin/sh
for arg in "$@"; do root="$arg"; done
printf '{"type":"match","data":{"path":{"text":"%s"},"lines":{"text":"from-bundled\\\\n"},"line_number":1,"submatches":[{"match":{"text":"from"},"start":0,"end":4}]}}\\n' "$root"
printf '{"type":"summary","data":{}}\\n'
`);
	await chmod(fake, 0o755);
	const dir = await sandbox(t, fake);
	await writeFile(join(dir, "sample.txt"), "from-fallback\n");

	const found = textOf(await grepTool.execute({ pattern: "from", path: "sample.txt" }, ctx(dir)));

	assert.equal(found, "sample.txt:1:from-bundled");
});
