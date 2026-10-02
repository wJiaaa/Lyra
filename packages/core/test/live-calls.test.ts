/**
 * Tool calls a dead process left open: each is answered once, as what it had got to.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentEvent } from "../src/agent/events.ts";
import type { AgentRunConfig } from "../src/agent/loop.ts";
import { runTools } from "../src/agent/tool-run.ts";
import { SessionLog } from "../src/runtime/session-log.ts";
import { sessionDb } from "../src/session/db.ts";
import { KEPT_OUTPUT_CHARS } from "../src/session/live-calls.ts";
import { SessionStore } from "../src/session/store.ts";
import { emptyUsage, type AssistantMessage, type Message, type Tool, type ToolResultMessage } from "../src/types.ts";

const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const call = (id: string, name = "bash") => ({ type: "toolCall" as const, id, name, arguments: { command: id } });

function asking(...ids: string[]): AssistantMessage {
	return { role: "assistant", content: ids.map((id) => call(id)), api: "openai-responses", provider: "p", model: "m", stopReason: "toolUse", usage: emptyUsage(), timestamp: 1 };
}

function answer(id: string): ToolResultMessage {
	return { role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text: "done" }], isError: false, timestamp: 2 };
}

const text = (message: Message) => message.content.map((block) => ("text" in block ? block.text : "")).join("");

async function withStore(run: (store: SessionStore, root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "ly-live-calls-"));
	const store = new SessionStore(root);
	try {
		await run(store, root);
	} finally {
		store.close();
		await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
	}
}

function deadPid(): number {
	const pid = spawnSync(process.execPath, ["-e", ""]).pid;
	assert.ok(pid);
	return pid;
}

function kill(store: SessionStore): void {
	sessionDb(store.path).prepare("UPDATE live_calls SET owner_pid = ?").run(deadPid());
}

test("a round cut off by a dead process is answered once, each call as far as it got", async () => {
	await withStore(async (store, root) => {
		const meta = await store.create(root, "m");
		await store.append(meta, { type: "message", message: user("go") });
		await store.append(meta, { type: "message", message: asking("build", "deploy", "done", "later") });
		await store.openCall(meta.id, "build");
		await store.saveCallOutput(meta.id, "build", "compiling…\nerror: x is undefined");
		await store.openCall(meta.id, "deploy");
		await store.markCall(meta.id, "deploy", "approval");
		await store.openCall(meta.id, "done");
		await store.append(meta, { type: "message", message: answer("done") });

		// Its process is still here: nothing to settle yet.
		assert.equal((await store.load(meta.id))?.messages.length, 3);

		kill(store);
		const loaded = await new SessionStore(root).load(meta.id);
		const results = loaded?.messages.slice(3) as ToolResultMessage[];
		assert.deepEqual(results.map((m) => m.toolCallId), ["build", "deploy", "later"], "in call order, the answered one left alone");
		assert.match(text(results[0]), /may or may not have taken effect/);
		assert.match(text(results[0]), /error: x is undefined/, "with what it had printed");
		assert.match(text(results[1]), /waiting for approval, so it never started/);
		assert.match(text(results[2]), /before this call started/);
		assert.deepEqual(results.map((m) => (m.details as { cancelled?: boolean }).cancelled === true), [false, true, true], "a call that never ran is not a failure");

		assert.equal((await store.load(meta.id))?.messages.length, 6, "and only once");
		assert.equal(sessionDb(store.path).prepare("SELECT COUNT(*) AS n FROM live_calls").get()?.n, 0);
	});
});

test("one live call holds the whole round: the calls after it are about to start", async () => {
	await withStore(async (store, root) => {
		const meta = await store.create(root, "m");
		await store.append(meta, { type: "message", message: asking("first", "second") });
		await store.openCall(meta.id, "first");
		assert.equal((await new SessionStore(root).load(meta.id))?.messages.length, 1);
	});
});

test("a conversation that moved on is not answered behind its back", async () => {
	await withStore(async (store, root) => {
		const meta = await store.create(root, "m");
		await store.append(meta, { type: "message", message: asking("old") });
		await store.openCall(meta.id, "old");
		await store.append(meta, { type: "message", message: user("something else") });
		kill(store);
		assert.deepEqual((await store.load(meta.id))?.messages.map((m) => m.role), ["assistant", "user"]);
		assert.equal(sessionDb(store.path).prepare("SELECT COUNT(*) AS n FROM live_calls").get()?.n, 0, "the stale row goes");
	});
});

test("a session records how far its calls got, and forgets each once it is answered", async () => {
	await withStore(async (store, root) => {
		const meta = await store.create(root, "m");
		const log = new SessionLog(store, async () => {}, meta);
		const row = () => sessionDb(store.path).prepare("SELECT phase, output FROM live_calls WHERE call_id = 'c'").get() as { phase: string; output: string | null } | undefined;
		await log.commit(asking("c"));
		await log.emit({ type: "tool_start", toolCallId: "c", toolName: "bash", args: {}, summary: "bash" });
		assert.deepEqual({ ...row() }, { phase: "running", output: null });
		await log.emit({ type: "tool_phase", toolCallId: "c", phase: "approval" });
		assert.equal(row()?.phase, "approval");
		await log.emit({ type: "tool_phase", toolCallId: "c", phase: "running" });
		const long = "x".repeat(KEPT_OUTPUT_CHARS) + "tail";
		await log.emit({ type: "tool_update", toolCallId: "c", partial: { content: [{ type: "text", text: long }] } });
		await log.emit({ type: "tool_update", toolCallId: "c", partial: { content: [{ type: "text", text: "too soon to write" }] } });
		assert.equal(row()?.output?.length, KEPT_OUTPUT_CHARS, "the tail is what is kept");
		assert.ok(row()?.output?.endsWith("tail"), "and an update within the second is not written");
		await log.commit(answer("c"));
		assert.equal(row(), undefined);
	});
});

test("a call stopped while it waited for approval is told it never ran", async () => {
	const controller = new AbortController();
	const events: AgentEvent[] = [];
	const gated: Tool = {
		name: "bash",
		snippet: "bash",
		description: "bash",
		parameters: { type: "object", properties: {} },
		execute: async (_args, ctx) => {
			await ctx.requestApproval?.({ kind: "bash", title: "bash", detail: "rm" });
			return { content: [{ type: "text", text: "ran" }] };
		},
	};
	const config = {
		sessionId: "s",
		cwd: "/tmp",
		tools: [gated],
		messages: [],
		systemPrompt: "",
		signal: controller.signal,
		requestApproval: () => {
			queueMicrotask(() => controller.abort());
			return new Promise<never>(() => {});
		},
	} as unknown as AgentRunConfig;
	const [result] = await runTools([call("c")], config, new Map(), async (event) => void events.push(event));
	assert.match(text(result), /waited for approval, so it never ran/);
	assert.deepEqual(events.filter((e) => e.type === "tool_phase").map((e) => (e as { phase: string }).phase), ["approval"]);
});
