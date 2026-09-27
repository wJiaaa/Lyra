import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionStore } from "../src/session/store.ts";

const user = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }], timestamp: 1 });

test("in-run events do not rewrite the index, and the next message brings it up to date", async () => {
	const root = await mkdtemp(join(tmpdir(), "ly-index-writes-"));
	try {
		const store = new SessionStore(root);
		let meta = await store.create(root, "m");
		meta = await store.append(meta, { type: "message", message: user("hi") });
		const before = await readFile(join(root, "index.json"), "utf8");
		for (let i = 0; i < 5; i++) meta = await store.append(meta, { type: "event", event: { type: "tool_start", toolCallId: `t${i}`, toolName: "read", args: {} } as never });
		assert.equal(await readFile(join(root, "index.json"), "utf8"), before, "five appends, no index rewrite");

		meta = await store.append(meta, { type: "event", event: { type: "agent_end", reason: "stop" } as never });
		const listed = (await store.listSessions()).find((entry) => entry.id === meta.id);
		assert.equal(listed?.seq, meta.seq, "at rest the index matches the log");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a fresh process appending from a lagging index entry continues the log's numbering", async () => {
	const root = await mkdtemp(join(tmpdir(), "ly-index-writes-"));
	try {
		const first = new SessionStore(root);
		let meta = await first.create(root, "m");
		meta = await first.append(meta, { type: "message", message: user("hi") });
		for (let i = 0; i < 3; i++) meta = await first.append(meta, { type: "event", event: { type: "request", provider: "p", model: "m", messageCount: 1 } as never });

		// As after a crash mid-run: only the index is at hand, and it is behind the log.
		const second = new SessionStore(root);
		const stale = (await second.listSessions()).find((entry) => entry.id === meta.id)!;
		assert.ok(stale.seq < meta.seq, "precondition: the index lags");
		await second.setArchived(meta.projectId, meta.id, true);
		const seqs: number[] = [];
		for await (const record of second.read(meta.projectId, meta.id)) seqs.push(record.seq);
		assert.equal(new Set(seqs).size, seqs.length, `no sequence number is reused: ${seqs.join(",")}`);
		assert.equal(seqs.at(-1), meta.seq + 1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
