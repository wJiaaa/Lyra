import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, realpath, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore } from "@plume/core";
import { exportTrajectory } from "../electron/trajectory-export.ts";

test("exports the full authoritative record, refuses unknown sessions and does not trust an output path", async () => {
	const root = await mkdtemp(join(tmpdir(), "plume-export-"));
	const previous = process.env.PLUME_HOME; process.env.PLUME_HOME = root;
	const exported: string[] = [];
	try {
		const store = new SessionStore(join(root, "sessions"));
		let meta = await store.create(root, "qa");
		const output = "LONG_OUTPUT\n".repeat(1000) + "TAIL";
		const path = join(root, "scratch", meta.id, "tool-output", "result.log");
		await mkdir(dirname(path), { recursive: true }); await writeFile(path, output);
		meta = await store.append(meta, { type: "message", message: { role: "toolResult", toolCallId: "call", toolName: "bash", content: [{ type: "text", text: output }], timestamp: 1, isError: false, details: { outputPath: path } } });
		const json = await exportTrajectory(store, meta.id, "json"); exported.push(dirname(json));
		assert.ok((await readFile(json, "utf8")).includes("TAIL"));
		const md = await exportTrajectory(store, meta.id, "md"); exported.push(dirname(md));
		assert.ok((await readFile(md, "utf8")).includes(output));
		assert.equal(await exportTrajectory(store, meta.id, "output", { correlationId: "call" }), await realpath(path));
		await assert.rejects(exportTrajectory(store, "missing", "json"), /不存在/);
		await assert.rejects(exportTrajectory(store, meta.id, "json", { id: "unknown" }), /尚未落盘/);
		meta = await store.append(meta, { type: "event", event: { type: "tool_start", toolCallId: "live", toolName: "bash", args: { command: "pnpm build" }, summary: "build" } });
		const live = await exportTrajectory(store, meta.id, "json", { correlationId: "live" }, true); exported.push(dirname(live));
		assert.match(await readFile(live, "utf8"), /"status": "running"/);
		const cold = await exportTrajectory(store, meta.id, "json", { correlationId: "live" }); exported.push(dirname(cold));
		assert.match(await readFile(cold, "utf8"), /"status": "interrupted"/);
		const secret = join(root, "private.txt"); await writeFile(secret, "unrelated");
		await store.append(meta, { type: "message", message: { role: "toolResult", toolCallId: "bad", toolName: "bash", content: [], timestamp: 2, isError: false, details: { outputPath: secret } } });
		await assert.rejects(exportTrajectory(store, meta.id, "output", { correlationId: "bad" }), /不属于当前会话/);
	} finally {
		if (previous === undefined) delete process.env.PLUME_HOME; else process.env.PLUME_HOME = previous;
		await Promise.all([...exported, root].map(path => rm(path, { recursive: true, force: true })));
	}
});
