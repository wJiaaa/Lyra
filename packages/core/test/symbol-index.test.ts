import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { buildIndex, INDEX_VERSION, saveIndex } from "../src/index/symbols.ts";
import { symbolTool } from "../src/tools/symbol.ts";

async function workspace(t: TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "ly-symbols-"));
	const previous = process.env.PLUME_HOME;
	process.env.PLUME_HOME = join(root, "home");
	t.after(async () => {
		if (previous === undefined) delete process.env.PLUME_HOME;
		else process.env.PLUME_HOME = previous;
		await rm(root, { recursive: true, force: true });
	});
	return root;
}

const textOf = (res: Awaited<ReturnType<typeof symbolTool.execute>>) => res.content.map((part) => ("text" in part ? part.text : "")).join("");

test("函数体里的局部变量不进索引；顶层常量、嵌套的函数照收", async (t) => {
	const dir = await workspace(t);
	await writeFile(join(dir, "a.ts"), [
		"export const MENU_WIDTH = { compact: 190 };",
		"function resolvedWidth(width) {",
		"\tconst fixed = widthOf(width);",
		"\tfunction inner() {}",
		"\treturn fixed;",
		"}",
	].join("\n"));

	const names = (await buildIndex(dir)).symbols.map((entry) => entry.name);

	assert.deepEqual(names, ["MENU_WIDTH", "resolvedWidth", "inner"]);
});

test("磁盘上旧规则建的索引不再沿用，按现在的规则重建", async (t) => {
	const dir = await workspace(t);
	await writeFile(join(dir, "a.ts"), "export function fresh() {}\n");
	// 没有 version：上一版规则建的，里面也没有 `fresh`。
	await saveIndex({ cwd: dir, builtAt: Date.now(), fileCount: 0, symbols: [], skipped: 0 });

	const found = textOf(await symbolTool.execute({ name: "fresh" }, { cwd: dir, sessionId: "s", state: new Map() }));

	assert.match(found, /a\.ts:1/);
});

test("索引没建完时，找不到要说清楚是没建到，不是不存在", async (t) => {
	const dir = await workspace(t);
	await saveIndex({ cwd: dir, builtAt: Date.now(), fileCount: 1, symbols: [], skipped: 0, version: INDEX_VERSION, truncated: true });

	const found = textOf(await symbolTool.execute({ name: "missing" }, { cwd: dir, sessionId: "s", state: new Map() }));

	assert.match(found, /never indexed/);
});
