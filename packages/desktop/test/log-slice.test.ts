/**
 * 任务面板里看后台命令的输出：日志文件一段一段读，第一次从末尾开始，之后只读新增的。
 */

import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readLogSlice } from "../electron/log-slice.ts";

async function log(content: string | Buffer) {
	const dir = await mkdtemp(join(tmpdir(), "ly-log-slice-"));
	const path = join(dir, "job.log");
	await writeFile(path, content);
	return { path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("接着上次读：只给新增的部分，读到末尾时说一声", async () => {
	const file = await log("first\n");
	try {
		const one = await readLogSlice(file.path, 0);
		assert.deepEqual(one, { text: "first\n", next: 6, atEnd: true });
		await appendFile(file.path, "second\n");
		const two = await readLogSlice(file.path, one.next);
		assert.deepEqual(two, { text: "second\n", next: 13, atEnd: true });
		assert.deepEqual(await readLogSlice(file.path, two.next), { text: "", next: 13, atEnd: true });
	} finally {
		await file.cleanup();
	}
});

test("第一次打开一份很长的日志：从末尾一段开始，而且从整行开始", async () => {
	const lines = Array.from({ length: 200 }, (_, index) => `line ${index}\n`).join("");
	const file = await log(lines);
	try {
		const slice = await readLogSlice(file.path, -1, 64);
		assert.ok(slice.text.length <= 64, "只读末尾那一段，不从头重放");
		assert.match(slice.text, /^line \d+\n/, "开头是一整行，不是半截");
		assert.ok(slice.text.endsWith("line 199\n"));
		assert.equal(slice.next, Buffer.byteLength(lines));
		assert.equal(slice.atEnd, true);
	} finally {
		await file.cleanup();
	}
});

test("一次读不完：停在完整的字符上，剩下的字节下次接着读，拼起来一字不差", async () => {
	const text = "构建".repeat(20) + "\n";
	const file = await log(text);
	try {
		let from = 0;
		let seen = "";
		for (let reads = 0; reads < 20; reads++) {
			const slice = await readLogSlice(file.path, from, 7);
			assert.doesNotMatch(slice.text, /�/, "切在汉字中间会变成替换字符");
			seen += slice.text;
			from = slice.next;
			if (slice.atEnd) break;
		}
		assert.equal(seen, text);
	} finally {
		await file.cleanup();
	}
});
