/**
 * 把会话库里的记录原样倒出来：一条记录一行 JSON，和以前的 `.jsonl` 日志是同一个形状。
 *
 * 会话存进 SQLite 之后，`cat`、`grep`、`jq` 这些顺手的工具就够不着它了。排查一条会话、或者把它
 * 交给别人看的时候，用这个脚本取出来。只读打开，应用开着也可以跑。
 *
 * 用法：
 *   pnpm dump:session                 列出所有会话（id、最后活动时间、消息数、标题）
 *   pnpm dump:session <id 或其前缀>    打印这条会话的全部记录
 *   pnpm dump:session <id> > s.jsonl
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const path = join(process.env.PLUME_HOME || join(homedir(), ".plume"), "sessions", "sessions.db");
if (!existsSync(path)) {
	console.error(`读不到 ${path} —— 这台机器上还没有会话记录。`);
	process.exit(1);
}
const db = new DatabaseSync(path, { readOnly: true });
const wanted = process.argv[2];

if (!wanted) {
	const rows = db.prepare("SELECT id, updated_at, message_count, meta FROM sessions ORDER BY updated_at DESC").all() as { id: string; updated_at: number; message_count: number; meta: string }[];
	for (const row of rows) console.log(`${row.id}  ${new Date(row.updated_at).toISOString()}  ${String(row.message_count).padStart(5)}  ${(JSON.parse(row.meta) as { title?: string }).title ?? ""}`);
} else {
	const ids = (db.prepare("SELECT id FROM sessions WHERE id LIKE ? || '%'").all(wanted) as { id: string }[]).map((row) => row.id);
	if (ids.length !== 1) {
		console.error(ids.length === 0 ? `没有以 ${wanted} 开头的会话。` : `${wanted} 能对上 ${ids.length} 条会话，再多给几位：\n${ids.join("\n")}`);
		process.exit(1);
	}
	for (const row of db.prepare("SELECT body FROM records WHERE session_id = ? ORDER BY seq").iterate(ids[0]) as Iterable<{ body: string }>) {
		process.stdout.write(`${row.body}\n`);
	}
}
db.close();
