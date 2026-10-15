/**
 * `grep` / `glob` 报出来的路径要能原样交给 `read`：相对工作区根写，不是相对搜索目录。
 *
 * 真实会话里 `grep` 带 `path: "src"` 报出 `pages/Login/index.tsx`，模型拿去 `read`，File not found。
 */

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { globTool } from "../src/tools/glob.ts";
import { grepTool } from "../src/tools/grep.ts";
import { displayPath } from "../src/tools/paths.ts";

const ctx = (cwd: string) => ({ cwd, sessionId: "s", state: new Map<string, unknown>() });
const textOf = (res: { content: { type: string; text?: string }[] }) => res.content.map((part) => part.text ?? "").join("");

/** 工作区里放一个 `src/pages/a.tsx`，`PLUME_RIPGREP` 指向给定的程序。 */
async function workspace(t: TestContext, ripgrep: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "plume-search-paths-"));
	const home = await mkdtemp(join(tmpdir(), "plume-search-home-"));
	const saved = { PLUME_RIPGREP: process.env.PLUME_RIPGREP, PLUME_HOME: process.env.PLUME_HOME };
	process.env.PLUME_RIPGREP = ripgrep;
	process.env.PLUME_HOME = home;
	t.after(async () => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(dir, { recursive: true, force: true });
		await rm(home, { recursive: true, force: true });
	});
	await mkdir(join(dir, "src", "pages"), { recursive: true });
	await writeFile(join(dir, "src", "pages", "a.tsx"), "needle\n");
	return dir;
}

/** 照真 ripgrep 的样子：报的路径以传进来的搜索根打头。`--json` 出事件流，否则出 `--files-with-matches` 的一行。 */
async function fakeRipgrep(dir: string): Promise<string> {
	const bin = join(dir, "bin");
	await mkdir(bin);
	const fake = join(bin, "rg");
	await writeFile(fake, `#!/bin/sh
for arg in "$@"; do root="$arg"; done
case " $* " in
*" --json "*)
	printf '{"type":"match","data":{"path":{"text":"%s/pages/a.tsx"},"lines":{"text":"needle\\\\n"},"line_number":1,"submatches":[{"match":{"text":"needle"},"start":0,"end":6}]}}\\n' "$root"
	printf '{"type":"summary","data":{}}\\n' ;;
*) printf '%s/pages/a.tsx\\n' "$root" ;;
esac
`);
	await chmod(fake, 0o755);
	return fake;
}

test("grep 走 ripgrep 时，带 path 搜出的路径相对工作区根", async (t) => {
	const dir = await workspace(t, join(tmpdir(), "plume-no-such-ripgrep"));
	process.env.PLUME_RIPGREP = await fakeRipgrep(dir);

	assert.equal(textOf(await grepTool.execute({ pattern: "needle", path: "src" }, ctx(dir))), "src/pages/a.tsx:1:needle");
	assert.equal(textOf(await grepTool.execute({ pattern: "needle", path: "src", files_only: true }, ctx(dir))), "src/pages/a.tsx");
});

test("grep 兜底扫描时，带 path 搜出的路径相对工作区根", async (t) => {
	const dir = await workspace(t, join(tmpdir(), "plume-no-such-ripgrep"));

	assert.equal(textOf(await grepTool.execute({ pattern: "needle", path: "src" }, ctx(dir))), "src/pages/a.tsx:1:needle");
});

test("glob 的模式按搜索目录匹配，报出的路径相对工作区根", async (t) => {
	const dir = await workspace(t, join(tmpdir(), "plume-no-such-ripgrep"));

	assert.equal(textOf(await globTool.execute({ pattern: "pages/*.tsx", path: "src" }, ctx(dir))), "src/pages/a.tsx");
});

test("displayPath：工作区外写绝对路径，`..` 开头的文件名仍在工作区里", () => {
	const root = join(tmpdir(), "ws");
	assert.equal(displayPath(root, join(root, "src", "a.ts")), "src/a.ts");
	assert.equal(displayPath(root, join(root, "..x", "a.ts")), "..x/a.ts");
	assert.equal(displayPath(root, join(tmpdir(), "other", "a.ts")), join(tmpdir(), "other", "a.ts"));
});
