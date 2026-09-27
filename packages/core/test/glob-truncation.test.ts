import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { globTool } from "../src/tools/glob.ts";

test("glob walks the whole tree, so newest-first and the remaining count are real", async (t) => {
	// 以前找到 2000 个就停止遍历：最新的文件在后面的目录里就排不进来，「还有 N 个」也偏小。
	const dir = await mkdtemp(join(tmpdir(), "lyra-glob-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const old = new Date("2020-01-01");
	for (const group of ["a", "b"]) {
		await mkdir(join(dir, group));
		for (let i = 0; i < 1500; i++) {
			const file = join(dir, group, `f${i}.ts`);
			await writeFile(file, "");
			await utimes(file, old, old);
		}
	}
	await writeFile(join(dir, "b", "newest.ts"), "");
	const res = await globTool.execute({ pattern: "**/*.ts", limit: 10 }, { cwd: dir, sessionId: "s", state: new Map() });
	const text = res.content.map((part) => (part.type === "text" ? part.text : "")).join("");
	assert.equal(text.split("\n")[0], "b/newest.ts");
	assert.match(text, /\[2991 more matches not shown\]/);
	assert.equal((res.details as { count: number }).count, 3001);
});
