/**
 * 回复里的界面块与 `preview` 在真实会话里是怎么被用的。
 *
 * 为什么要有这个文件：界面块的组件目录、提示词里那一段，都是照着设想写的，没有一个数字说过模型真的
 * 会写哪些、写错哪些。加组件、改说明之前先在这里量：
 *
 *   - 能用界面块的会话里，模型写了几块 ```ui、调了几次 `preview`，各是为了什么请求（第 1、2 节）
 *   - 每一块用生产的 `checkBlock` 重查一遍：哪种错最多、想用却没有的组件是哪些（第 3 节）
 *   - 人点了几次界面里的按钮（第 4 节）
 *
 * 「能用界面块」按会话记下的系统提示里有没有那一段来算，更早的会话不进分母。
 *
 * 用法：
 *   pnpm audit:interface
 *   pnpm audit:interface --json
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { checkBlock } from "../packages/core/src/ui-language/check.ts";
import { interfaceBlocks } from "../packages/core/src/ui-language/notes.ts";

const DB = join(homedir(), ".plume", "sessions", "sessions.db");
const asJson = process.argv.includes("--json");
const SECTION = "Interface blocks:";

interface Part {
	type: string;
	text?: string;
	name?: string;
	arguments?: Record<string, unknown>;
}
interface Message {
	role: string;
	content: string | Part[];
	displayText?: string;
	synthetic?: boolean;
}

const textOf = (message: Message) => (typeof message.content === "string" ? message.content : message.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n"));
const short = (text: string, length = 60) => text.replace(/\s+/g, " ").trim().slice(0, length);

/** 一条问题去掉具体的值，同一种错才能数到一起。 */
function kindOf(problem: string): string {
	const [path, ...rest] = problem.split(": ");
	const component = rest.length ? (path!.split(" > ").at(-1) ?? path!) : "";
	const message = (rest.length ? rest.join(": ") : problem).replace(/"[^"]*"/g, '"…"').replace(/\{[^}]*\}/g, "{…}").replace(/ \(state: [^)]*\)/, "");
	return component ? `${component}: ${message}` : message;
}

function tally(values: string[]): [string, number][] {
	const counts = new Map<string, number>();
	for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
	return [...counts].sort((a, b) => b[1] - a[1]);
}

if (!existsSync(DB)) {
	console.error(`没有找到会话库：${DB}`);
	process.exit(1);
}
const db = new DatabaseSync(DB, { readOnly: true });
const able = new Set(
	(db.prepare("select distinct session_id as id from records where kind = 'context' and body like ?").all(`%${SECTION}%`) as { id: string }[]).map((row) => row.id),
);
const rows = db.prepare("select session_id as id, body from records where kind = 'message' order by session_id, seq").all() as { id: string; body: string }[];

const blocks: { session: string; prompt: string; source: string; problems: string[] }[] = [];
const previews: { session: string; prompt: string; how: string }[] = [];
const sends: { session: string; words: string }[] = [];
const sessionsSeen = new Set<string>();
let lastPrompt = new Map<string, string>();

for (const row of rows) {
	if (!able.has(row.id)) continue;
	sessionsSeen.add(row.id);
	const message = (JSON.parse(row.body) as { message?: Message }).message;
	if (!message) continue;
	if (message.role === "user" && !message.synthetic) {
		const text = textOf(message);
		if (text.startsWith("<env>")) continue;
		if (text.includes("<interface-values>")) sends.push({ session: row.id, words: short(message.displayText ?? text) });
		lastPrompt.set(row.id, short(message.displayText ?? text));
		continue;
	}
	if (message.role !== "assistant" || typeof message.content === "string") continue;
	const prompt = lastPrompt.get(row.id) ?? "";
	for (const source of interfaceBlocks(textOf(message))) blocks.push({ session: row.id, prompt, source, problems: checkBlock(source) });
	for (const part of message.content) {
		if (part.type !== "toolCall" || part.name !== "preview") continue;
		const args = part.arguments ?? {};
		const how = args.id !== undefined ? "按 id 发布" : `${args.check ? "检查" : "直接发布"}·${args.path !== undefined ? "path" : args.files !== undefined ? "files" : "html"}`;
		previews.push({ session: row.id, prompt, how });
	}
}
lastPrompt = new Map();

const problems = blocks.flatMap((block) => block.problems.filter((problem) => !problem.startsWith("…and")));
const unknown = problems.map((problem) => /(?:^|> )([A-Za-z][\w.]*): not a component/.exec(problem)?.[1]).filter((name): name is string => Boolean(name));
const report = {
	sessions: { total: (db.prepare("select count(distinct session_id) as n from records").get() as { n: number }).n, withInterface: able.size, withMessages: sessionsSeen.size },
	blocks: { count: blocks.length, withProblems: blocks.filter((block) => block.problems.length).length, sessions: new Set(blocks.map((block) => block.session)).size },
	previews: { count: previews.length, sessions: new Set(previews.map((call) => call.session)).size, how: tally(previews.map((call) => call.how)) },
	promptsForBlocks: tally(blocks.map((block) => block.prompt)),
	promptsForPreviews: tally(previews.filter((call) => call.how !== "按 id 发布").map((call) => call.prompt)),
	problemKinds: tally(problems.map(kindOf)),
	unknownComponents: tally(unknown),
	sends: sends.length,
};

if (asJson) {
	console.log(JSON.stringify(report, null, 2));
	process.exit(0);
}
const list = (entries: [string, number][], limit = 15) => (entries.length ? entries.slice(0, limit).map(([value, n]) => `   ${String(n).padStart(4)}  ${value}`).join("\n") : "   （无）");
console.log(`界面块体检 · ${DB}

0. 样本
   会话 ${report.sessions.total} 个，其中系统提示里有界面块说明的 ${report.sessions.withInterface} 个
   ${report.sessions.withInterface < 20 ? "样本太少：下面的比例只能当线索，不能当结论。" : ""}

1. 用了多少
   界面块 ${report.blocks.count} 块，出现在 ${report.blocks.sessions} 个会话
   preview 调用 ${report.previews.count} 次，出现在 ${report.previews.sessions} 个会话
${list(report.previews.how)}

2. 为了什么请求（那一轮人说的第一句）
   写了界面块：
${list(report.promptsForBlocks)}
   调了 preview（不含按 id 发布）：
${list(report.promptsForPreviews)}

3. 写错了什么（${report.blocks.withProblems}/${report.blocks.count} 块有问题）
${list(report.problemKinds)}
   想用但目录里没有的组件：
${list(report.unknownComponents)}

4. 人点了界面里的按钮 ${report.sends} 次`);
