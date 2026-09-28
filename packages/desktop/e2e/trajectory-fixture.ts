import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionMeta, SessionRecordInput } from "@plume/core";

/** Synthetic events use the real JSONL reader, renderer, search and artifact access paths. */
export async function seedTrajectory(home: string): Promise<void> {
	const indexPath = join(home, "sessions", "index.json");
	const metas: SessionMeta[] = JSON.parse(await readFile(indexPath, "utf8"));
	const base = metas[0];
	const id = "10000000-0000-4000-8000-000000000001";
	const raw = join(home, "scratch", id, "tool-output", "build.log");
	await mkdir(join(home, "scratch", id, "tool-output"), { recursive: true });
	await writeFile(raw, "RAW_LOG\n".repeat(25000) + "RAW_FILE_TAIL");
	const start = Date.now() - 3_000_000;
	const usage = { input: 100, output: 20, cacheRead: 10, cacheWrite: 0, total: 130, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const meta: SessionMeta = { ...base, id, title: "大规模轨迹验证", seq: 0, messageCount: 5001 };
	let seq = 0;
	const records: string[] = [];
	const add = (input: SessionRecordInput, ts: number) => records.push(JSON.stringify({ ...input, ts, seq: seq++ }));
	add({ type: "meta", meta }, start);
	add({ type: "message", message: { role: "user", content: [{ type: "text", text: "执行并验证构建" }], timestamp: start } }, start);
	add({ type: "event", event: { type: "context", systemPrompt: "Synthetic trace fixture", tools: ["bash"], skills: [], schemas: [{ name: "bash", description: "Run command", parameters: { type: "object" } }] } }, start);
	for (let index = 0; index < 2500; index++) {
		const at = start + index * 1000;
		const callId = `trace-run-${index}`;
		const args = { command: `echo trace-${index}`, description: `构建验证 ${index}` };
		add({ type: "event", event: { type: "turn_start", turn: index + 1 } }, at);
		add({ type: "event", event: { type: "request", provider: "qa", model: "qa", messageCount: 2 * index + 1, thinking: "high" } }, at);
		add({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: callId, name: "bash", arguments: args }], api: "anthropic-messages", provider: "qa", model: "qa", timestamp: at, durationMs: 200, sseDurationMs: 80, usage, stopReason: "toolUse" } }, at + 200);
		add({ type: "event", event: { type: "tool_start", toolCallId: callId, toolName: "bash", args, summary: args.description } }, at + 210);
		add({ type: "message", message: { role: "toolResult", toolCallId: callId, toolName: "bash", content: [{ type: "text", text: index === 2499 ? "build output\n".repeat(1000) + "TAIL_SENTINEL" : `build result ${index}` }], details: { exitCode: index === 2499 ? 17 : 0, ...(index === 2499 ? { outputPath: raw, outputComplete: true } : {}) }, isError: index === 2499, startedAt: at + 210, durationMs: 140, timestamp: at + 350 } }, at + 350);
	}
	meta.seq = seq; meta.updatedAt = start + 2_500_000;
	add({ type: "meta", meta }, meta.updatedAt);
	await writeFile(join(home, "sessions", meta.projectId, `${id}.jsonl`), records.join("\n") + "\n");
	await writeFile(indexPath, JSON.stringify([...metas, meta]));
}
