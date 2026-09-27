import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createOutputLog } from "../src/tools/output-log.ts";
import { bashTool } from "../src/tools/bash.ts";

test("command output is retained beyond the model limit, in order, and closes idempotently", async () => {
	const root = await mkdtemp(join(tmpdir(), "lyra-output-"));
	try {
		const log = await createOutputLog(root); assert.ok(log);
		const chunks = Array.from({ length: 1500 }, (_, index) => `${index}: 中文日志 ${"x".repeat(200)}\n`);
		for (const chunk of chunks) log.append(chunk);
		const record = await log.close();
		assert.equal(await readFile(log.path, "utf8"), chunks.join(""));
		assert.equal(record.outputCharacters, chunks.join("").length);
		assert.equal(record.outputComplete, true);
		assert.deepEqual(await log.close(), record);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("the bash tool keeps raw output beyond 120k characters and links it from the persisted result", async () => {
	const root = await mkdtemp(join(tmpdir(), "lyra-bash-output-"));
	try {
		await writeFile(join(root, "generate.cjs"), `process.stdout.write('x'.repeat(150000) + 'RAW_OUTPUT_TAIL');`);
		const result = await bashTool.execute({ command: "node generate.cjs" }, { cwd: root, sessionId: "test-output", state: new Map(), scratchDir: join(root, "scratch"), sandboxMode: "danger-full-access" });
		assert.ok(!(Symbol.asyncIterator in result));
		assert.equal(result.isError, false, JSON.stringify(result));
		const details = result.details;
		assert.ok(details && typeof details === "object" && "outputPath" in details && typeof details.outputPath === "string");
		assert.equal(await readFile(details.outputPath, "utf8"), "x".repeat(150000) + "RAW_OUTPUT_TAIL");
		const preview = result.content.filter(part => part.type === "text").map(part => part.text).join("");
		assert.match(preview, /RAW_OUTPUT_TAIL\n\n\[full output: /);
		assert.ok(preview.includes(details.outputPath), "被截过的输出要让模型看得到完整日志在哪");
		assert.ok(preview.length < 61000);
	} finally { await rm(root, { recursive: true, force: true }); }
});
