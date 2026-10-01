/* oxlint-disable no-console -- probe CLI that prints what a session load actually costs */
/**
 * 打开一个大会话，钱花在哪一步。
 *
 * 「疯狂点会话，卡死」的现场是 254 个会话、最大的一个 25.2 MB、991 条消息。`readSelectedSession`
 * 里已经有合并闸了——同时只有一趟 IPC 在飞，中间点的那些折叠成最后一个——所以卡的不是排队，
 * 是单趟本身就太贵。贵在哪一步没量过，只能是猜：磁盘、`JSON.parse`、跨进程那次结构化克隆、
 * 还是拿到之后那几个各扫一遍的派生函数。
 *
 * 这里不开窗口（用户正开着 Plume 在用），只在 Node 里把同一批数据按同样的顺序过一遍，量每一段。
 * 跨进程那次没法在这里真做，用 `structuredClone` 顶替——它和 IPC 用的是同一套序列化。
 *
 * 用法：node --import tsx e2e/session-load-cost.ts [会话 id]
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { intact } from "../src/lib/transcript.ts";
import { howItStopped, rebuildToolRuns, todosFrom } from "../src/store/derive.ts";

// Read-only: the user's Plume may have this database open.
const db = new DatabaseSync(join(homedir(), ".plume", "sessions", "sessions.db"), { readOnly: true });

/** 最大的那几个会话，从大到小。 */
function biggest(n: number): string[] {
	const rows = db.prepare("SELECT session_id FROM records GROUP BY session_id ORDER BY SUM(LENGTH(CAST(body AS BLOB))) DESC LIMIT ?").all(n) as { session_id: string }[];
	return rows.map((row) => row.session_id);
}

function ms(label: string, run: () => unknown): number {
	const t0 = performance.now();
	const value = run();
	const dt = performance.now() - t0;
	const size = Array.isArray(value) ? `  (${value.length} 条)` : "";
	console.log(`   ${dt.toFixed(0).padStart(6)} ms  ${label}${size}`);
	return dt;
}

/** 主进程读一个会话：逐条记录 JSON.parse，取出 message 那些。 */
function parseTranscript(bodies: string[]): unknown[] {
	const messages: unknown[] = [];
	for (const body of bodies) {
		const record = JSON.parse(body) as { message?: unknown };
		if (record.message) messages.push(record.message);
	}
	return messages;
}

const ids = process.argv[2] ? [process.argv[2]] : biggest(3);

for (const id of ids) {
	const { bytes } = db.prepare("SELECT COALESCE(SUM(LENGTH(CAST(body AS BLOB))), 0) AS bytes FROM records WHERE session_id = ?").get(id) as { bytes: number };
	console.log(`\n【${id}】 ${(bytes / 1024 / 1024).toFixed(1)} MB`);

	let bodies: string[] = [];
	let messages: unknown[] = [];
	let cloned: unknown[] = [];

	const total =
		ms("读库", () => { bodies = (db.prepare("SELECT body FROM records WHERE session_id = ? ORDER BY seq").all(id) as { body: string }[]).map((row) => row.body); return null; }) +
		ms("逐条 JSON.parse（主进程）", () => { messages = parseTranscript(bodies); return messages; }) +
		ms("结构化克隆（相当于过一次 IPC）", () => { cloned = structuredClone(messages) as unknown[]; return cloned; }) +
		// 下面这些是拿到转录之后，渲染进程主线程上一个接一个跑的。
		ms("intact（进门那道闸）", () => intact(cloned as never)) +
		ms("rebuildToolRuns", () => rebuildToolRuns(cloned as never)) +
		ms("todosFrom", () => todosFrom(cloned as never)) +
		ms("howItStopped", () => howItStopped(cloned as never));

	console.log(`   ${"─".repeat(40)}`);
	console.log(`   ${total.toFixed(0).padStart(6)} ms  合计（不含 React 渲染）`);
}

db.close();
