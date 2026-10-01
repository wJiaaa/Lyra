import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionRecord } from "../src/session/store.ts";
import { readTrajectory } from "../src/trajectory/read.ts";
import { filterTrajectory } from "../src/trajectory/filter.ts";
import { emptyUsage, type AssistantMessage } from "../src/types.ts";

const usage = { ...emptyUsage(), input: 1200, output: 300, total: 1500 };
const assistant: AssistantMessage = { role: "assistant", content: [{ type: "text", text: "执行构建" }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "pnpm build", timeout: 9000 } }], timestamp: 100, durationMs: 100, sseDurationMs: 40, api: "anthropic-messages", provider: "qa", model: "qa", usage, stopReason: "toolUse" };
const source = (records: SessionRecord[]) => ({ async *read() { yield* records; } });

test("manual commands expose the request and persisted compaction summary", async () => {
	const command = { id: "compact-1", name: "compact", timestamp: 100, input: "/compact 保留决策", at: 20, status: "running", detail: "正在压缩" } as const;
	const records: SessionRecord[] = [
		{ seq: 1, ts: 100, type: "event", event: { type: "command_status", command } },
		{ seq: 2, ts: 200, type: "event", event: { type: "compacted", before: 20, after: 8, kept: 6, summary: "不可丢失的决策摘要" } },
		{ seq: 3, ts: 201, type: "event", event: { type: "command_status", command: { ...command, status: "done", detail: "已压缩" } } },
	];
	const entries = await readTrajectory({ async *read() { yield* records; } }, "s");
	assert.ok(entries.some(entry => entry.command === command.input));
	assert.ok(entries.some(entry => entry.detail.includes("不可丢失的决策摘要")));
	assert.equal(entries.length, 1, "one operation, updated in place");
	assert.equal(entries[0].durationMs, 101);
	assert.equal(entries[0].turn, undefined, "manual compaction runs between turns");
});

test("tools pair inputs, full output, errors and actual execution timing independently of request latency", async () => {
	const records: SessionRecord[] = [
		{ seq: 1, ts: 50, type: "message", message: { role: "user", content: [{ type: "text", text: "编译" }], timestamp: 50 } },
		{ seq: 2, ts: 100, type: "event", event: { type: "request", provider: "qa", model: "qa", thinking: "high", messageCount: 1 } },
		{ seq: 3, ts: 200, type: "message", message: assistant },
		{ seq: 4, ts: 210, type: "event", event: { type: "tool_start", toolCallId: "c1", toolName: "bash", args: { command: "pnpm build" }, summary: "build" } },
		{ seq: 5, ts: 250, type: "message", message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "line\n".repeat(2000) + "TAIL_SENTINEL" }], details: { exitCode: 17 }, timestamp: 250, startedAt: 210, durationMs: 40, isError: true } },
	];
	const entries = await readTrajectory(source(records), "s");
	const request = entries.find(entry => entry.source === "request");
	assert.equal(request?.ttftMs, 60); assert.equal(request?.durationMs, 100); assert.deepEqual(request?.usage, usage);
	const call = entries.find(entry => entry.source === "tool-call");
	assert.ok(call); assert.equal(call.status, "error"); assert.equal(call.durationMs, 40); assert.deepEqual(call.metadata, { exitCode: 17 });
	assert.ok(call.output?.endsWith("TAIL_SENTINEL")); assert.ok(call.linkedSeqs?.includes(5));
	assert.equal(filterTrajectory(entries, { query: "TAIL_SENTINEL", status: "error" }).length, 2);
	assert.equal(filterTrajectory(entries, { query: "pnpm build", sources: ["tool-call"], turn: 1 }).length, 1);
	assert.ok(filterTrajectory(entries, { time: { start: 230, end: 240 } }).includes(call), "time selection includes operations that overlap without starting inside the range");
	const rewound = await readTrajectory(source([...records, { seq: 6, ts: 300, type: "truncate", afterSeq: 4 }]), "s");
	const missing = rewound.find(entry => entry.source === "tool-call");
	assert.equal(missing?.status, "interrupted"); assert.equal(missing?.output, undefined); assert.equal(missing?.durationMs, undefined);
	assert.equal((await readTrajectory(source(records.slice(0, 4)), "s", true)).find(entry => entry.source === "tool-call")?.status, "running");
});

test("failed, cancelled and skipped manual commands persist even when no compacted event exists", async () => {
	for (const status of ["failed", "cancelled", "skipped"] as const) {
		const command = { id: status, name: "compact", timestamp: 100, input: "/compact", at: 0, status, detail: "明确的执行原因" } as const;
		const entries = await readTrajectory(source([{ seq: 1, ts: 110, type: "event", event: { type: "command_status", command } }]), "s");
		assert.equal(entries[0].status, status === "failed" ? "error" : status);
		assert.equal(entries[0].detail, command.detail);
	}
});

test("nested messages survive with parent links and tool call IDs are scoped to their agent", async () => {
	const result = { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "CHILD_OUTPUT" }], timestamp: 200, isError: false } as const;
	const records: SessionRecord[] = [
		{ seq: 1, ts: 100, type: "message", message: assistant },
		{ seq: 2, ts: 110, type: "event", event: { type: "subagent", id: "child", agent: "explore", description: "查代码", prompt: "find", tools: ["bash"], model: "small", provider: "p" } },
		{ seq: 3, ts: 120, type: "event", event: { type: "subagent_message", id: "child", message: { ...assistant, content: [...assistant.content] } } },
		{ seq: 4, ts: 200, type: "event", event: { type: "subagent_message", id: "child", message: { ...result, content: [...result.content] } } },
		{ seq: 5, ts: 220, type: "event", event: { type: "subagent_done", id: "child", answer: "done", steps: ["bash"], status: "done" } },
	];
	const entries = await readTrajectory(source(records), "s");
	assert.equal(entries.find(entry => entry.source === "tool-call" && entry.parentId === "child")?.output, "CHILD_OUTPUT");
	assert.equal(entries.find(entry => entry.source === "tool-call" && !entry.parentId)?.output, undefined);
	assert.equal(entries.find(entry => entry.seq === 2)?.durationMs, 110);
	assert.equal(filterTrajectory(entries, { query: "child" }).length, 5);
});

test("legacy tool-only replies retain usage without confusing model latency with tool execution", async () => {
	const entries = await readTrajectory(source([{ seq: 1, ts: 200, type: "message", message: { ...assistant, content: [{ type: "toolCall", id: "legacy", name: "bash", arguments: { command: "pnpm build" } }] } }]), "s");
	assert.equal(entries.length, 1);
	assert.deepEqual(entries[0].usage, usage);
	assert.equal(entries[0].durationMs, undefined);
	assert.equal(entries[0].status, "interrupted");
});

test("a request that throws before producing a message retains the actual failure and boundary", async () => {
	const entries = await readTrajectory(source([
		{ seq: 1, ts: 100, type: "event", event: { type: "request", provider: "qa", model: "qa", messageCount: 1 } },
		{ seq: 2, ts: 230, type: "event", event: { type: "agent_end", reason: "error", error: "connection closed" } },
	]), "s", true);
	assert.equal(entries[0].status, "error");
	assert.equal(entries[0].durationMs, 130);
	assert.deepEqual(entries[0].metadata, { thinking: undefined, messageCount: 1, error: "connection closed" });
});
