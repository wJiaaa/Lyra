/**
 * 转录里哪些 shell 命令算「在看」，和 read、grep 合成一段探索。
 *
 * 归类从严：串起来的每一段都得认得。错往「执行」那边偏只是多一行，错往「探索」那边偏会把一次
 * 测试、一次构建藏进「读取文件 5 个」里。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { isShellRead } from "../src/lib/shell-reads.ts";

test("读、搜、看 git 历史的命令算探索", () => {
	for (const command of [
		"rg -n foo src",
		"sed -n 1,80p src/app.ts",
		"cd packages/desktop && git log --oneline -5",
		"git -C ../other diff --stat",
		"cat a.ts; echo ----; head -20 b.ts",
		"grep -rn foo . 2>/dev/null | sort | uniq -c",
		"wc -l src/*.ts 2>&1 | tail -1",
		"FOO=1 /usr/bin/grep x y",
		"Get-Content README.md",
	]) {
		assert.equal(isShellRead(command), true, command);
	}
});

test("引号里的竖线和分号是参数，不是管道", () => {
	assert.equal(isShellRead(`rg "signIn|signOut" src`), true);
	assert.equal(isShellRead(`grep -E 'a;b' file`), true);
	assert.equal(isShellRead(`rg "a\\"|b" src`), true);
});

test("跑程序、写文件的不算，沾一个读命令也不算", () => {
	for (const command of [
		"pnpm test | tail -5",
		"npm run build",
		"rg foo > out.txt",
		"cat a >> b",
		"echo hi &> log.txt",
		"sed -i 's/a/b/' file",
		"sed -i.bak 's/a/b/' file",
		"find . -name '*.tmp' -delete",
		"git commit -m wip",
		"rg foo | xargs rm",
		"cd src",
		"",
	]) {
		assert.equal(isShellRead(command), false, command);
	}
});
