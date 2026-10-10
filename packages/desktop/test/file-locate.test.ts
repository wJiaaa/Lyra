/**
 * 回复里写的相对路径在项目里找：`approvals.ts`、相对子包的 `scripts/x.mjs` 都要落到真正那一个文件上。
 *
 * 用真仓库：匹配交给 `git ls-files`，被忽略的目录不该混进来，这件事只有 git 自己说得准。
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { locateInProject } from "../electron/file-locate.ts";

let repo: string;

before(() => {
	repo = mkdtempSync(join(tmpdir(), "plume-locate-"));
	const file = (path: string, text = "") => {
		mkdirSync(join(repo, path, ".."), { recursive: true });
		writeFileSync(join(repo, path), text);
	};
	file("README.md");
	file("packages/core/src/runtime/approvals.ts");
	file("packages/desktop/scripts/check-native-arch.mjs");
	file("packages/core/src/agent/tool-run.ts");
	file("packages/desktop/src/store/tool-run.ts");
	file("node_modules/pkg/approvals.ts");
	file(".gitignore", "node_modules/\n");
	execFileSync("git", ["init", "-q"], { cwd: repo, stdio: "pipe" });
});

after(() => rmSync(repo, { recursive: true, force: true }));

test("工作目录下就有的，原样返回，不去搜", async () => {
	assert.deepEqual(await locateInProject(repo, "README.md"), ["README.md"]);
});

test("只写文件名的，找到项目里那一个；被 .gitignore 忽略的同名文件不算", async () => {
	assert.deepEqual(await locateInProject(repo, "approvals.ts"), ["packages/core/src/runtime/approvals.ts"]);
});

test("相对子包写的路径，按结尾找到它", async () => {
	assert.deepEqual(await locateInProject(repo, "scripts/check-native-arch.mjs"), ["packages/desktop/scripts/check-native-arch.mjs"]);
});

test("同名的有两个，两个都列出来，由调用方决定不猜", async () => {
	assert.equal((await locateInProject(repo, "tool-run.ts")).length, 2);
});

test("走出项目的、带通配符的、不存在的，都是空", async () => {
	assert.deepEqual(await locateInProject(repo, "../etc/passwd"), []);
	assert.deepEqual(await locateInProject(repo, "*.ts"), []);
	assert.deepEqual(await locateInProject(repo, "nowhere.ts"), []);
});
